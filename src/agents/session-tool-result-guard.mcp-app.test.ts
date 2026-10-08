import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import { augmentChatHistoryWithCanvasBlocks } from "../gateway/chat-display-projection.canvas.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function widgetPreview(id: string) {
  return {
    kind: "canvas",
    view: { id, title: "Synthetic widget" },
    presentation: { target: "assistant_message", title: "Synthetic widget", sandbox: "scripts" },
    mcpApp: {
      viewId: id,
      serverName: "example",
      toolName: "show_widget",
      uiResourceUri: "ui://example/widget.html",
      toolCallId: id,
      originSessionKey: "agent:main:main",
      resultMetaState: "unavailable",
    },
  };
}

// Exercise the guarded append boundary, not just the persistence-cap helper.
function persistWidgetDetails(details: Record<string, unknown>[]) {
  const sm = SessionManager.inMemory();
  installSessionToolResultGuard(sm);
  const append = (message: unknown) => sm.appendMessage(message as AppendMessage);
  details.forEach((value, index) => {
    const id = "call-" + index;
    append({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "example__show_widget", arguments: {} }],
    });
    append({
      role: "toolResult",
      toolCallId: id,
      toolName: "example__show_widget",
      content: [{ type: "text", text: "Widget ready" }],
      details: value,
      isError: false,
      timestamp: 1,
    });
    append({ role: "assistant", content: [{ type: "text", text: "Widget generated" }] });
  });
  // An ordinary tool after the widget must not replace it either.
  append({
    role: "assistant",
    content: [{ type: "toolCall", id: "ordinary", name: "read", arguments: {} }],
  });
  append({
    role: "toolResult",
    toolCallId: "ordinary",
    toolName: "read",
    content: [{ type: "text", text: "Ordinary result" }],
    isError: false,
    timestamp: 1,
  });
  append({ role: "assistant", content: [{ type: "text", text: "Final answer" }] });
  const messages = sm
    .getEntries()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const results = messages
    .filter((message) => message.role === "toolResult")
    .filter((message) => message.toolName === "example__show_widget");
  for (const result of results) {
    expect(Buffer.byteLength(JSON.stringify(result.details), "utf8")).toBeLessThanOrEqual(8192);
  }
  const projected = augmentChatHistoryWithCanvasBlocks(messages);
  const canvases = projected.flatMap((entry) => {
    const message = asOptionalRecord(entry);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((value) => {
      const block = asOptionalRecord(value);
      return block?.type === "canvas" ? [block] : [];
    });
  });
  return { results, canvases };
}

const largePayload = { points: "x".repeat(60_000) };

describe("direct MCP widget persistence", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "keeps both widgets through final history projection (large: %s, %s)",
    (firstLarge, secondLarge) => {
      const details = [firstLarge, secondLarge].map((large, index) => ({
        mcpServer: "example",
        mcpTool: "show_widget",
        structuredContent: large ? largePayload : { points: [] },
        mcpAppPreview: widgetPreview("mcp-app-" + index),
      }));
      const { results, canvases } = persistWidgetDetails(details);
      expect(canvases).toHaveLength(2);
      expect(canvases.map((canvas) => asOptionalRecord(canvas.preview)?.viewId)).toEqual([
        "mcp-app-0",
        "mcp-app-1",
      ]);
      results.forEach((result, index) => {
        expect(result.details).toHaveProperty(
          "mcpAppPreview.mcpApp",
          details[index]?.mcpAppPreview.mcpApp,
        );
        expect(result.details).toHaveProperty("mcpServer", "example");
        expect(result.details).toHaveProperty("mcpTool", "show_widget");
      });
      if (firstLarge) {
        expect(results[0]?.details).not.toHaveProperty("structuredContent");
      } else {
        expect(results[0]?.details).toEqual(details[0]);
      }
    },
  );

  it("keeps the descriptor when both summary and fallback exceed the details cap", () => {
    const details = {
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => ["diagnostic-" + index + "x".repeat(300), true]),
      ),
      structuredContent: largePayload,
      status: "x".repeat(10_000),
      mcpAppPreview: widgetPreview("mcp-app-fallback"),
    };
    const { results, canvases } = persistWidgetDetails([details]);
    expect(results[0]?.details).toHaveProperty("finalDetailsTruncated", true);
    expect(results[0]?.details).toHaveProperty("mcpAppPreview");
    expect(canvases).toHaveLength(1);
  });

  it("redacts retained descriptors and drops unrelated preview metadata", () => {
    const preview = widgetPreview("mcp-app-redacted");
    preview.view.title = "password=synthetic-password-123456";
    preview.presentation.title = preview.view.title;
    const { results, canvases } = persistWidgetDetails([
      {
        structuredContent: largePayload,
        mcpAppPreview: {
          ...preview,
          arbitraryServerData: { password: "synthetic-password-123456" },
        },
      },
    ]);
    const details = expectDefined(results[0]?.details, "expected persisted widget details");
    expect(JSON.stringify(details)).not.toContain("synthetic-password-123456");
    expect(details).not.toHaveProperty("mcpAppPreview.arbitraryServerData");
    expect(canvases).toHaveLength(1);
  });

  it.each([
    undefined,
    { kind: "canvas", view: { id: "mcp-app-invalid" } },
    { ...widgetPreview("mcp-app-mismatch"), view: { id: "other" } },
    { ...widgetPreview("mcp-app-oversized"), diagnostic: "x".repeat(10_000) },
  ])("does not preserve missing, invalid, or oversized descriptors", (preview) => {
    const { results, canvases } = persistWidgetDetails([
      { structuredContent: largePayload, mcpAppPreview: preview },
    ]);
    expect(results[0]?.details).not.toHaveProperty("mcpAppPreview");
    expect(canvases).toHaveLength(0);
  });
});
