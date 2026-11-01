import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { fetchOpencodeGoUsage } from "./usage.js";

const rollingReset = "2026-11-01T17:06:57.000Z";
const weeklyReset = "2026-11-02T00:00:00.000Z";
const monthlyReset = "2026-11-20T20:13:16.000Z";

describe("fetchOpencodeGoUsage", () => {
  it("maps rolling, weekly, and monthly windows", async () => {
    const mockFetch = createProviderUsageFetch(async (url, init) => {
      expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(init?.headers).toMatchObject({
        Accept: "application/json",
      });
      return makeResponse(200, {
        usage: {
          rolling: { status: "ok", percent: 1, resetsAt: rollingReset },
          weekly: { status: "ok", percent: 28, resetsAt: weeklyReset },
          monthly: { status: "ok", percent: 26, resetsAt: monthlyReset },
        },
      });
    });

    await expect(fetchOpencodeGoUsage("opencode-key", 5000, mockFetch)).resolves.toEqual({
      provider: "opencode-go",
      displayName: "OpenCode Go",
      windows: [
        { label: "5-hour", usedPercent: 1, resetAt: Date.parse(rollingReset) },
        { label: "Weekly", usedPercent: 28, resetAt: Date.parse(weeklyReset) },
        { label: "Monthly", usedPercent: 26, resetAt: Date.parse(monthlyReset) },
      ],
    });
  });

  it("keeps explicit zero usage and skips windows without a percent", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        usage: {
          rolling: { status: "ok", percent: 0, resetsAt: rollingReset },
          weekly: { status: "ok" },
          monthly: { status: "exhausted", percent: 100, resetsAt: monthlyReset },
        },
      }),
    );

    await expect(fetchOpencodeGoUsage("opencode-key", 5000, mockFetch)).resolves.toEqual({
      provider: "opencode-go",
      displayName: "OpenCode Go",
      windows: [
        { label: "5-hour", usedPercent: 0, resetAt: Date.parse(rollingReset) },
        { label: "Monthly (exhausted)", usedPercent: 100, resetAt: Date.parse(monthlyReset) },
      ],
    });
  });

  it("clamps provider-reported percentages", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        usage: { monthly: { status: "ok", percent: 137, resetsAt: monthlyReset } },
      }),
    );

    await expect(fetchOpencodeGoUsage("opencode-key", 5000, mockFetch)).resolves.toEqual({
      provider: "opencode-go",
      displayName: "OpenCode Go",
      windows: [{ label: "Monthly", usedPercent: 100, resetAt: Date.parse(monthlyReset) }],
    });
  });

  it("returns token-expired errors for usage auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(401, { error: "nope" }));
    await expect(fetchOpencodeGoUsage("opencode-key", 5000, mockFetch)).resolves.toEqual({
      provider: "opencode-go",
      displayName: "opencode-go",
      windows: [],
      error: "Token expired",
    });
  });

  it.each([
    [403, "HTTP 403"],
    [429, "HTTP 429"],
    [500, "HTTP 500"],
  ])("keeps HTTP %i distinct from expired credentials", async (status, error) => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(status, { error: "nope" }));
    await expect(fetchOpencodeGoUsage("opencode-key", 5000, mockFetch)).resolves.toEqual({
      provider: "opencode-go",
      displayName: "opencode-go",
      windows: [],
      error,
    });
  });

  it("does not wait for body cancellation on HTTP errors", async () => {
    // A capture tee can leave cancel() pending until its sibling reader drains.
    const mockFetch = createProviderUsageFetch(
      async () =>
        ({
          ok: false,
          status: 429,
          body: { cancel: () => new Promise<void>(() => {}) },
        }) as unknown as Response,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("hung on body cancellation")), 500);
    });

    const snapshot = await Promise.race([
      fetchOpencodeGoUsage("opencode-key", 5000, mockFetch),
      guard,
    ]);
    clearTimeout(timer);
    expect(snapshot).toEqual({
      provider: "opencode-go",
      displayName: "opencode-go",
      windows: [],
      error: "HTTP 429",
    });
  });

  it.each([
    ["malformed JSON", "{not-json", "Malformed usage response"],
    ["missing usage", {}, "Malformed usage response"],
    ["empty usage", { usage: {} }, "No usage data"],
    [
      "windows without percent",
      { usage: { rolling: { status: "ok" }, weekly: { status: "ok" } } },
      "No usage data",
    ],
  ])("returns an error for %s", async (_name, payload, error) => {
    const mockFetch = createProviderUsageFetch(async () =>
      typeof payload === "string"
        ? new Response(payload, { status: 200, headers: { "content-type": "application/json" } })
        : makeResponse(200, payload),
    );
    const result = await fetchOpencodeGoUsage("opencode-key", 5000, mockFetch);
    expect(result.error).toBe(error);
    expect(result.windows).toHaveLength(0);
  });
});
