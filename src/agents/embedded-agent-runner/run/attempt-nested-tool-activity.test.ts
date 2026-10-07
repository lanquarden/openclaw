import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readNestedToolActivity,
  type NestedToolActivity,
} from "../../../sessions/nested-tool-activity.js";
import { registerAgentSessionLoopTestLifecycle } from "../../sessions/agent-session-loop-correctness.test-support.js";
import { ACTIVE_EMBEDDED_RUNS } from "../run-state.js";

const mocks = vi.hoisted(() => ({
  clearActiveRun: vi.fn(),
  notifyToolActivity: vi.fn(),
  setActiveRun: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: mocks.subscribe,
}));
vi.mock("../runs.js", () => ({
  clearActiveEmbeddedRun: mocks.clearActiveRun,
  setActiveEmbeddedRun: mocks.setActiveRun,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: mocks.notifyToolActivity,
}));

import {
  createCatalogSubscription,
  prepareCatalogExecutor,
} from "./attempt-stream-prepare.test-support.js";

registerAgentSessionLoopTestLifecycle();

const EXAMPLE_WIDGET_URI = "ui://example/widget.html";
const EXAMPLE_WIDGET_PREVIEW = {
  kind: "canvas",
  view: { id: "mcp-app-example", title: "show_widget UI" },
  presentation: { target: "assistant_message", title: "show_widget UI" },
  mcpApp: {
    viewId: "mcp-app-example",
    serverName: "example",
    toolName: "show_widget",
    uiResourceUri: EXAMPLE_WIDGET_URI,
  },
};
const EXAMPLE_WIDGET_META = { ui: { resourceUri: EXAMPLE_WIDGET_URI } };

/** Exercise the release's real catalog executor, recording, and redaction path. */
async function runNestedCatalogTool(result: unknown) {
  const activities: NestedToolActivity[] = [];
  const prepared = prepareCatalogExecutor(activities);
  try {
    await prepared.toolSearchCatalogExecutor({
      tool: { name: "show_widget", execute: async () => result } as never,
      toolName: "show_widget",
      source: "mcp",
      toolCallId: "nested-app",
      parentToolCallId: "outer-exec",
      input: {},
      acceptResultBeforeProjection: async (candidate) => candidate,
    });
    expect(activities).toHaveLength(1);
    return activities[0]!;
  } finally {
    prepared.subscription.unsubscribe();
  }
}

function oversizedStructuredContent() {
  return {
    items: Array.from({ length: 6_000 }, (_, index) => `item-${index}-${"x".repeat(8)}`),
  };
}

describe("nested MCP App activity recording", () => {
  afterEach(async () => {
    const { testing } = await import("../runs.test-support.js");
    testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    ACTIVE_EMBEDDED_RUNS.clear();
    const runs = await vi.importActual<typeof import("../runs.js")>("../runs.js");
    mocks.setActiveRun.mockImplementation(runs.setActiveEmbeddedRun);
    mocks.clearActiveRun.mockImplementation(runs.clearActiveEmbeddedRun);
    mocks.subscribe.mockReturnValue(createCatalogSubscription());
  });

  it("retains a bounded preview without duplicate metadata when output is elided", async () => {
    const activity = await runNestedCatalogTool({
      content: [{ type: "text", text: "synthetic widget payload" }],
      details: {
        structuredContent: oversizedStructuredContent(),
        mcpAppPreview: EXAMPLE_WIDGET_PREVIEW,
        _meta: EXAMPLE_WIDGET_META,
      },
      _meta: EXAMPLE_WIDGET_META,
    });
    expect(activity.details.result.content).toEqual([
      { type: "text", text: "[Nested tool output omitted: exceeds display limit]" },
    ]);
    expect(activity.details.result.details).toEqual({ mcpAppPreview: EXAMPLE_WIDGET_PREVIEW });
    expect(activity.details.result._meta).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(activity.details.result), "utf8")).toBeLessThanOrEqual(
      32_768,
    );
    expect(readNestedToolActivity(activity)).toBeDefined();
  });

  it("preserves preview and top-level UI metadata for under-limit results", async () => {
    const activity = await runNestedCatalogTool({
      content: [{ type: "text", text: "widget ready" }],
      details: { mcpAppPreview: EXAMPLE_WIDGET_PREVIEW },
      _meta: EXAMPLE_WIDGET_META,
      mcpAppResourceUri: EXAMPLE_WIDGET_URI,
    });
    expect(activity.details.result.content).toEqual([{ type: "text", text: "widget ready" }]);
    expect(activity.details.result.details).toEqual({ mcpAppPreview: EXAMPLE_WIDGET_PREVIEW });
    expect(activity.details.result._meta).toEqual(EXAMPLE_WIDGET_META);
    expect(activity.details.result.mcpAppResourceUri).toBe(EXAMPLE_WIDGET_URI);
  });

  it("records terminal tool results without persisting runtime-only termination flags", async () => {
    const activity = await runNestedCatalogTool({
      content: [{ type: "text", text: "widget ready" }],
      details: { mcpAppPreview: EXAMPLE_WIDGET_PREVIEW },
      terminate: true,
    });
    expect(activity.details.result).toEqual({
      content: [{ type: "text", text: "widget ready" }],
      details: { mcpAppPreview: EXAMPLE_WIDGET_PREVIEW },
    });
    expect(readNestedToolActivity(activity)).toBeDefined();
  });

  it("falls back to bounded UI metadata when the materialized preview is oversized", async () => {
    const activity = await runNestedCatalogTool({
      content: [{ type: "text", text: "synthetic widget payload" }],
      details: {
        structuredContent: oversizedStructuredContent(),
        mcpAppPreview: { ...EXAMPLE_WIDGET_PREVIEW, padding: "x".repeat(8_192) },
        _meta: { ...EXAMPLE_WIDGET_META, secret: "server-internal" },
        mcpAppResourceUri: EXAMPLE_WIDGET_URI,
      },
    });
    expect(activity.details.result.details).toEqual({
      _meta: EXAMPLE_WIDGET_META,
      mcpAppResourceUri: EXAMPLE_WIDGET_URI,
    });
    expect(JSON.stringify(activity)).not.toContain("server-internal");
    expect(Buffer.byteLength(JSON.stringify(activity.details.result), "utf8")).toBeLessThanOrEqual(
      32_768,
    );
  });

  it.each([
    ["non-app URI", "https://example/widget.html", false],
    ["URI at the length limit", `ui://${"x".repeat(2_043)}`, true],
    ["URI over the length limit", `ui://${"x".repeat(2_044)}`, false],
  ] as const)("bounds the fallback resource URI: %s", async (_label, resourceUri, retained) => {
    const activity = await runNestedCatalogTool({
      content: [{ type: "text", text: "synthetic widget payload" }],
      details: {
        structuredContent: oversizedStructuredContent(),
        mcpAppResourceUri: resourceUri,
      },
    });
    expect(activity.details.result.details).toEqual(
      retained ? { mcpAppResourceUri: resourceUri } : undefined,
    );
    expect(readNestedToolActivity(activity)).toBeDefined();
  });

  it("retains only allowlisted UI metadata and a bounded URI without a preview", async () => {
    const activity = await runNestedCatalogTool({
      content: [{ type: "text", text: "synthetic widget payload" }],
      details: {
        structuredContent: oversizedStructuredContent(),
        _meta: { ui: { resourceUri: EXAMPLE_WIDGET_URI }, secret: "server-internal" },
        mcpAppResourceUri: EXAMPLE_WIDGET_URI,
      },
    });
    expect(activity.details.result.details).toEqual({
      _meta: EXAMPLE_WIDGET_META,
      mcpAppResourceUri: EXAMPLE_WIDGET_URI,
    });
    expect(JSON.stringify(activity)).not.toContain("server-internal");
    expect(Buffer.byteLength(JSON.stringify(activity.details.result), "utf8")).toBeLessThanOrEqual(
      32_768,
    );
    expect(readNestedToolActivity(activity)).toBeDefined();
  });
});
