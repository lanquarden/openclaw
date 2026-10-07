import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

export const NESTED_TOOL_ACTIVITY_CUSTOM_TYPE = "openclaw.nested-tool.v1";

const correlationId = z.string().min(1).max(1024);
/**
 * Result envelope persisted for a nested (catalog/deferred) tool call.
 *
 * Besides the model-visible `content`/`details`, MCP integrations surface an app
 * descriptor (CallToolResult `_meta`, `appContext`, `mcpAppResourceUri`, and the
 * materialized `details.mcpAppPreview`) that the Control UI needs to register and
 * render an MCP App. The previous default-strip result object omitted these slots;
 * declare them explicitly so they survive validation before reaching the transcript.
 */
const activityResult = z
  .object({
    content: z.array(z.unknown()),
    details: z.unknown().optional(),
    structuredContent: z.unknown().optional(),
    _meta: z.unknown().optional(),
    appContext: z.unknown().optional(),
    mcpAppResourceUri: z.string().optional(),
  })
  // Runtime-only flags (e.g. terminate) are valid tool results, not transcript fields.
  .strip();
const activityDetails = z
  .object({
    runId: correlationId,
    scopeId: correlationId,
    afterEntryId: correlationId.nullable(),
    startOrder: z.number().int().nonnegative(),
    parentToolCallId: correlationId.optional(),
    toolCallId: correlationId,
    toolName: z.string().min(1).max(256),
    input: z.unknown(),
    result: activityResult,
    isError: z.boolean(),
    startedAt: z.number().finite(),
    timestamp: z.number().finite(),
  })
  .strict();
const activitySchema = z.object({
  role: z.literal("custom"),
  customType: z.literal(NESTED_TOOL_ACTIVITY_CUSTOM_TYPE),
  display: z.literal(true),
  excludeFromContext: z.literal(true),
  content: z.literal(""),
  details: activityDetails,
  timestamp: z.number().finite(),
});
let compiledActivitySchema: typeof activitySchema | undefined;

function getActivitySchema() {
  // Ordinary transcript rows never pay the one-time compilation cost.
  return (compiledActivitySchema ??= z.compile(activitySchema));
}

export type NestedToolActivity = z.infer<typeof activitySchema>;

/** Validate correlation slots separately from the payloads that always require redaction. */
export function readNestedToolActivity(value: unknown): NestedToolActivity | undefined {
  if (asOptionalRecord(value)?.customType !== NESTED_TOOL_ACTIVITY_CUSTOM_TYPE) {
    return undefined;
  }
  const parsed = getActivitySchema().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const MAX_RESULT_BYTES = 32_768;
const MAX_APP_DESCRIPTOR_BYTES = 8_192;
const MAX_APP_RESOURCE_URI_LENGTH = 2_048;

function readBoundedRecord(
  value: unknown,
  maxBytes = MAX_APP_DESCRIPTOR_BYTES,
): Record<string, unknown> | undefined {
  const record = asOptionalRecord(value);
  return record && boundedJsonUtf8Bytes(record, maxBytes).complete ? record : undefined;
}

function readBoundedResourceUri(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.startsWith("ui://") &&
    value.length <= MAX_APP_RESOURCE_URI_LENGTH
    ? value
    : undefined;
}

/** Only the UI slice of a CallToolResult `_meta` is app-relevant; drop other server metadata. */
function readBoundedUiMeta(value: unknown): { ui: Record<string, unknown> } | undefined {
  const ui = readBoundedRecord(asOptionalRecord(value)?.ui);
  return ui ? { ui } : undefined;
}

/**
 * Replace an oversized nested result with a display placeholder while retaining a
 * single, bounded app descriptor. Truncating the whole envelope would otherwise
 * discard the `viewId`/`resourceUri` the Control UI needs, so a catalog/deferred
 * MCP tool would run successfully yet render no MCP App.
 */
function elideNestedToolResult(result: unknown): Record<string, unknown> {
  const record = asOptionalRecord(result);
  const resultDetails = asOptionalRecord(record?.details);
  const content = [{ type: "text", text: "[Nested tool output omitted: exceeds display limit]" }];
  // Prefer the materialized descriptor the Control UI actually reads.
  const preview = readBoundedRecord(resultDetails?.mcpAppPreview);
  const details: Record<string, unknown> = {};
  if (preview) {
    details.mcpAppPreview = preview;
  } else {
    // Fall back to the raw UI descriptor for native/other producers; keep only
    // allowlisted UI metadata (never the arbitrary `_meta` payload) and a bounded URI.
    const uiMeta = readBoundedUiMeta(resultDetails?._meta) ?? readBoundedUiMeta(record?._meta);
    if (uiMeta) {
      details._meta = uiMeta;
    }
    const resourceUri =
      readBoundedResourceUri(resultDetails?.mcpAppResourceUri) ??
      readBoundedResourceUri(record?.mcpAppResourceUri);
    if (resourceUri) {
      details.mcpAppResourceUri = resourceUri;
    }
  }
  const elided: Record<string, unknown> =
    Object.keys(details).length > 0 ? { content, details } : { content };
  // Guarantee the retained descriptor stays within the original display cap.
  if (boundedJsonUtf8Bytes(elided, MAX_RESULT_BYTES).complete) {
    return elided;
  }
  return preview ? { content, details: { mcpAppPreview: preview } } : { content };
}

/** Keep each terminal activity bounded independently of provider context. */
export function createNestedToolActivity(
  details: Omit<NestedToolActivity["details"], "result"> & { result: unknown },
): NestedToolActivity {
  const input = boundedJsonUtf8Bytes(details.input, 8_192).complete
    ? structuredClone(details.input)
    : "[Nested tool input omitted: exceeds display limit]";
  const result = boundedJsonUtf8Bytes(details.result, MAX_RESULT_BYTES).complete
    ? details.result
    : elideNestedToolResult(details.result);
  return getActivitySchema().parse({
    role: "custom",
    customType: NESTED_TOOL_ACTIVITY_CUSTOM_TYPE,
    display: true,
    excludeFromContext: true,
    content: "",
    details: { ...details, input, result },
    timestamp: details.startedAt,
  });
}

/** Tool-card content for public history. */
export function nestedToolActivityContent({ details }: NestedToolActivity) {
  const { input, result, ...call } = details;
  return [
    {
      type: "toolCall",
      id: call.toolCallId,
      runId: call.runId,
      name: call.toolName,
      arguments: input,
      parentToolCallId: call.parentToolCallId,
      timestamp: call.startedAt,
    },
    { ...call, ...result, type: "toolResult" },
  ] as const;
}

/** Hooks retain call/result evidence; model snapshots and context engines stay unchanged. */
export function projectNestedToolActivityForHooks(
  messages: readonly unknown[],
  activities: readonly NestedToolActivity[],
): unknown[] {
  return [
    ...messages,
    ...activities.map((activity) => ({
      ...activity,
      // Role/content observers need distinct invocations, not fabricated model turns.
      content: JSON.stringify({
        scopeId: activity.details.scopeId,
        toolCallId: activity.details.toolCallId,
        toolName: activity.details.toolName,
        isError: activity.details.isError,
      }),
    })),
  ];
}
