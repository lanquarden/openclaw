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

  it.each([undefined, false])(
    "handles deeply nested structured content as an error even when isError is %s",
    (isError) => {
      // Build iteratively so the fixture itself does not overflow the call stack.
      let structuredContent: Record<string, unknown> = { answer: 42 };
      for (let depth = 0; depth < 20_000; depth += 1) {
        structuredContent = { nested: structuredContent };
      }
      const result = projectMcpCallToolResult(
        {
          content: [{ type: "text", text: "query a specific field" }],
          structuredContent,
          isError,
          _meta: { ui: { resourceUri: "ui://example/widget.html" }, secret: "server-internal" },
        },
        { mcpServer: "example", mcpTool: "show_widget" },
      );
      expect(result.content).toEqual([
        {
          type: "text",
          text: "structuredContent was too deeply nested to project. Ask the MCP server for a flatter result or query a specific field.",
        },
        { type: "text", text: "query a specific field" },
      ]);
      expect(result.details).toEqual({
        mcpServer: "example",
        mcpTool: "show_widget",
        status: "error",
        _meta: { ui: { resourceUri: "ui://example/widget.html" } },
      });
      // Both downstream digests and the Code Mode bridge must avoid the deep value.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(consumeMcpCodeModeGuestResult(result)).toEqual({
        content: result.content,
        isError: true,
      });
      expect(consumeMcpCodeModeGuestResult(result)).toBeUndefined();
    },
  );

  it("deduplicates only the full structured-content mirror and retains recovery guidance", () => {
    const structuredContent = { z: 2, a: 1 };
    const content = [
      { type: "text", text: JSON.stringify(structuredContent, null, 2) },
      { type: "text", text: "Use a narrower query if this result is incomplete." },
    ];
    const result = projectMcpCallToolResult({ content, structuredContent });
    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{\n  "a": 1,\n  "z": 2\n}' },
      content[1],
    ]);
    expect(result.details).toEqual({ structuredContent });
    expect(consumeMcpCodeModeGuestResult(result)).toEqual({ content, structuredContent });
  });

  it("does not disguise non-RangeError projection failures as excessive nesting", () => {
    const error = new TypeError("synthetic serialization failure");
    const structuredContent = {
      get answer() {
        throw error;
      },
    };
    expect(() => projectMcpCallToolResult({ structuredContent })).toThrow(error);
  });
});
