import { describe, expect, it } from "vitest";
import {
  createNestedToolActivity,
  nestedToolActivityContent,
  readNestedToolActivity,
} from "../sessions/nested-tool-activity.js";
import { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";

// Regression: a large MCP App tool result rendered inline while the run was live
// but lost its inline canvas once the committed message was re-projected/read.
// The deferred (catalog) recording path bounded the result to 32 KiB and, on
// overflow, replaced the whole envelope — including `details.mcpAppPreview` —
// with a display placeholder. The commit-time canvas reconstruction in
// `augmentChatHistoryWithCanvasBlocks` reads `details.mcpAppPreview`, so the
// canvas vanished for large results while small ones persisted.

const WIDGET_URI = "ui://example/widget.html";
const WIDGET_PREVIEW = {
  kind: "canvas",
  view: { id: "mcp-app-example", title: "show_widget UI" },
  presentation: { target: "assistant_message", title: "show_widget UI", sandbox: "scripts" },
  mcpApp: {
    viewId: "mcp-app-example",
    serverName: "example",
    toolName: "show_widget",
    uiResourceUri: WIDGET_URI,
    toolCallId: "nested-app",
  },
};

/** A structured payload comfortably past the 32 KiB nested display cap. */
const LARGE_STRUCTURED_CONTENT = {
  points: Array.from({ length: 6_000 }, (_, index) => `item-${index}-${"x".repeat(8)}`),
};

function recordNestedResult(result: unknown) {
  return createNestedToolActivity({
    runId: "run-1",
    scopeId: "scope-1",
    afterEntryId: null,
    startOrder: 0,
    toolCallId: "nested-app",
    toolName: "show_widget",
    input: {},
    result,
    isError: false,
    startedAt: 1,
    timestamp: 2,
  });
}

/** Rebuild the transcript-shaped custom row the commit-time projection sees. */
function projectedNestedMessage(activity: ReturnType<typeof recordNestedResult>) {
  const [call, toolResult] = nestedToolActivityContent(activity);
  return {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    display: true,
    content: [call, toolResult],
    details: activity.details,
    timestamp: 2,
  };
}

/** Runs the same commit-time reconstruction used when chat history is re-read. */
function committedCanvasPreviews(activity: ReturnType<typeof recordNestedResult>) {
  const augmented = augmentChatHistoryWithCanvasBlocks([
    projectedNestedMessage(activity),
    { role: "assistant", content: [{ type: "text", text: "widget ready" }] },
  ]);
  const assistant = augmented.at(-1) as { content?: Array<{ type?: string }> };
  return (assistant.content ?? []).filter((block) => block.type === "canvas");
}

describe("MCP App commit-time canvas for deferred (nested) tool results", () => {
  it("keeps a bounded app descriptor for oversized results so the canvas survives re-projection", () => {
    const activity = recordNestedResult({
      content: [{ type: "text", text: "synthetic widget payload" }],
      details: {
        mcpServer: "example",
        mcpTool: "show_widget",
        structuredContent: LARGE_STRUCTURED_CONTENT,
        mcpAppPreview: WIDGET_PREVIEW,
      },
    });
    const recorded = activity.details.result as Record<string, unknown>;

    // The bulk output is elided to a display placeholder…
    expect(recorded.content).toEqual([
      { type: "text", text: "[Nested tool output omitted: exceeds display limit]" },
    ]);
    // …but the app descriptor is retained and stays within the original cap.
    expect((recorded.details as Record<string, unknown>).mcpAppPreview).toEqual(WIDGET_PREVIEW);
    expect(Buffer.byteLength(JSON.stringify(recorded), "utf8")).toBeLessThanOrEqual(32_768);
    expect(readNestedToolActivity(activity)).toBeDefined();

    // The commit-time reconstruction still derives the inline canvas.
    const canvases = committedCanvasPreviews(activity);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({
      type: "canvas",
      preview: { mcpApp: { viewId: "mcp-app-example" } },
    });
  });

  it("keeps the app descriptor and content for results under the display cap", () => {
    const activity = recordNestedResult({
      content: [{ type: "text", text: "widget ready" }],
      details: { mcpServer: "example", mcpTool: "show_widget", mcpAppPreview: WIDGET_PREVIEW },
    });
    const recorded = activity.details.result as Record<string, unknown>;
    expect(recorded.content).toEqual([{ type: "text", text: "widget ready" }]);
    expect((recorded.details as Record<string, unknown>).mcpAppPreview).toEqual(WIDGET_PREVIEW);
    expect(committedCanvasPreviews(activity)).toHaveLength(1);
  });

  it("documents the failure mode: no descriptor means no reconstructed canvas", () => {
    // An oversized result without a materialized preview loses its app identity,
    // which is exactly the pre-fix behaviour that dropped the large-result canvas.
    const activity = recordNestedResult({
      content: [{ type: "text", text: "synthetic widget payload" }],
      details: { mcpServer: "example", mcpTool: "show_widget", structuredContent: LARGE_STRUCTURED_CONTENT },
    });
    const recorded = activity.details.result as Record<string, unknown>;
    expect(recorded.details).toBeUndefined();
    expect(committedCanvasPreviews(activity)).toHaveLength(0);
  });
});
