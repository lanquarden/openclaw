// OpenCode Go subscription usage: OpenClaw's provider-neutral quota surface.
import {
  asNonNegativeFiniteNumber,
  parseDateStringTimestampMs,
} from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildUsageHttpErrorSnapshot,
  clampPercent,
  fetchJson,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const OPENCODE_GO_DISPLAY_NAME = "OpenCode Go";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Go meters each model against its own monthly limit, split into a rolling
// 5-hour window (20%), a weekly window (50%), and the monthly window (100%).
const OPENCODE_GO_USAGE_WINDOWS = [
  ["rolling", "5-hour"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
] as const;

function buildWindow(label: string, entry: Record<string, unknown>): UsageWindow | undefined {
  const percent = asNonNegativeFiniteNumber(entry.percent);
  if (percent === undefined) {
    return undefined;
  }
  const status = normalizeOptionalString(entry.status);
  return {
    label: status && status !== "ok" ? `${label} (${status})` : label,
    usedPercent: clampPercent(percent),
    resetAt: parseDateStringTimestampMs(entry.resetsAt),
  };
}

export function buildOpencodeGoUsageSnapshot(payload: unknown): ProviderUsageSnapshot {
  const usage = asOptionalRecord(asOptionalRecord(payload)?.usage);
  if (!usage) {
    return {
      provider: OPENCODE_GO_PROVIDER_ID,
      displayName: OPENCODE_GO_DISPLAY_NAME,
      windows: [],
      error: "Malformed usage response",
    };
  }

  const windows: UsageWindow[] = [];
  for (const [key, label] of OPENCODE_GO_USAGE_WINDOWS) {
    const entry = asOptionalRecord(usage[key]);
    const window = entry ? buildWindow(label, entry) : undefined;
    if (window) {
      windows.push(window);
    }
  }

  if (windows.length === 0) {
    return {
      provider: OPENCODE_GO_PROVIDER_ID,
      displayName: OPENCODE_GO_DISPLAY_NAME,
      windows: [],
      error: "No usage data",
    };
  }

  return {
    provider: OPENCODE_GO_PROVIDER_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    windows,
  };
}

export async function fetchOpencodeGoUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const response = await fetchJson(
    OPENCODE_GO_USAGE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    fetchFn,
  );
  if (!response.ok) {
    // A capture tee can leave cancellation pending until the sibling reader
    // finishes, so release the body without awaiting it (see
    // src/infra/http-response-body.ts: an HTTP error must not become a timeout).
    void response.body?.cancel().catch(() => undefined);
    return buildUsageHttpErrorSnapshot({
      provider: OPENCODE_GO_PROVIDER_ID,
      status: response.status,
      // A shared OpenCode key without Go entitlement answers 403; that is
      // denied access, not proof of an expired credential.
      tokenExpiredStatuses: [401],
    });
  }

  try {
    return buildOpencodeGoUsageSnapshot(
      await readProviderJsonResponse<unknown>(response, "opencode-go-usage"),
    );
  } catch {
    return {
      provider: OPENCODE_GO_PROVIDER_ID,
      displayName: OPENCODE_GO_DISPLAY_NAME,
      windows: [],
      error: "Malformed usage response",
    };
  }
}
