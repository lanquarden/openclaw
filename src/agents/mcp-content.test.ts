import { describe, expect, it } from "vitest";
import { consumeMcpCodeModeGuestResult, projectMcpCallToolResult } from "./mcp-content.js";

describe("projectMcpCallToolResult UI metadata", () => {
  it("preserves only the allowlisted UI slice of CallToolResult metadata", () => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: "ok" }],
      _meta: { ui: { resourceUri: "ui://example/widget.html" }, secret: "server-internal" },
    });
    expect(result.details).toEqual({
      _meta: { ui: { resourceUri: "ui://example/widget.html" } },
    });
    expect(JSON.stringify(result)).not.toContain("server-internal");
    expect(consumeMcpCodeModeGuestResult(result)).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("omits metadata without a UI descriptor", () => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: "ok" }],
      _meta: { trace: "abc" },
    });
    expect(result.details).not.toHaveProperty("_meta");
  });

  it("preserves the release's structured content and error projections", () => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: "recovery guidance" }],
      structuredContent: { answer: 42 },
      isError: true,
      _meta: { ui: { resourceUri: "ui://example/widget.html" } },
    });
    expect(result.details).toEqual({
      structuredContent: { answer: 42 },
      status: "error",
      _meta: { ui: { resourceUri: "ui://example/widget.html" } },
    });
    expect(consumeMcpCodeModeGuestResult(result)).toEqual({
      content: [{ type: "text", text: "recovery guidance" }],
      structuredContent: { answer: 42 },
      isError: true,
    });
  });

  it("preserves only the allowlisted UI slice of the CallToolResult `_meta`", () => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: "ok" }],
      _meta: { ui: { resourceUri: "ui://example/widget.html" }, secret: "server-internal" },
    });
    expect((result.details as Record<string, unknown>)._meta).toEqual({
      ui: { resourceUri: "ui://example/widget.html" },
    });
    expect(JSON.stringify(result.details)).not.toContain("server-internal");
  });

  it("omits `_meta` when it carries no UI descriptor", () => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: "ok" }],
      _meta: { trace: "abc" },
    });
    expect(result.details).not.toHaveProperty("_meta");
  });
});
