import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

const NESTED_TOOL_ACTIVITY_CUSTOM_TYPE = "openclaw.nested-tool.v1";

const correlationId = z.string().min(1).max(1024);
/**
 * The previous default-strip result object omitted top-level MCP App descriptor
 * fields. Admit them explicitly so they survive transcript validation.
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
  .strict();
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

/** Retain one bounded app descriptor when oversized nested output is elided. */
function elideNestedToolResult(result: unknown): Record<string, unknown> {
  const record = asOptionalRecord(result);
  const resultDetails = asOptionalRecord(record?.details);
  const content = [{ type: "text", text: "[Nested tool output omitted: exceeds display limit]" }];
  const preview = readBoundedRecord(resultDetails?.mcpAppPreview);
  const details: Record<string, unknown> = {};
  if (preview) {
    details.mcpAppPreview = preview;
  } else {
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
