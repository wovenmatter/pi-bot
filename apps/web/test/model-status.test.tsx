import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeModelStatus, ModelStatusBanner } from "../src/components/ModelStatusBanner.tsx";
import { MessageError } from "../src/components/ui.tsx";
import { MAX_FALLBACKS, ProfileEditor } from "../src/features/settings/Profiles.tsx";
import type { ModelStatusSummary, ProviderModels } from "../src/protocol.ts";

const TZ = "America/New_York";
// Thu Oct 29 2026, 20:00 UTC = 4:00 PM EDT.
const NOW = Date.UTC(2026, 9, 29, 20, 0);
const status = (extra: Partial<ModelStatusSummary>): ModelStatusSummary => ({
  kind: "fallback",
  at: NOW,
  primary: "openai-codex/gpt-6-sol",
  active: "claude-subscription/opus-5.5",
  limits: [],
  ...extra,
});

describe("model status banner", () => {
  it("says which limit was hit, when it resets and the fallback in use", () => {
    const text = describeModelStatus(
      status({
        limits: [
          {
            model: "openai-codex/gpt-6-sol",
            account: "ChatGPT account",
            kind: "five_hour",
            resetsAt: NOW + 90 * 60_000,
            retryAt: NOW + 90 * 60_000,
          },
        ],
      }),
      "Worker",
      TZ,
    );
    expect(text.tone).toBe("warning");
    expect(text.title).toBe(
      "Your ChatGPT account hit its 5-hour usage limit (openai-codex/gpt-6-sol).",
    );
    expect(text.lines).toEqual([
      "Resets Thu, 5:30 PM EDT.",
      "Worker is now using claude-subscription/opus-5.5 until then.",
    ]);
  });

  it("only says what is known, and explains a pause", () => {
    const text = describeModelStatus(
      status({
        kind: "paused",
        active: "openrouter/x/y",
        primary: "openrouter/x/y",
        limits: [
          {
            model: "openrouter/x/y",
            account: "OpenRouter key",
            kind: "credits",
            retryAt: NOW + 15 * 60_000,
          },
        ],
      }),
      "Worker",
      TZ,
    );
    expect(text.tone).toBe("error");
    expect(text.title).toBe("Your OpenRouter key ran out of credits (openrouter/x/y).");
    expect(text.lines[0]).toBe(
      "Reset time not reported; Pi Bot tries again around Thu, 4:15 PM EDT.",
    );
    expect(text.lines[1]).toContain("no fallback");
    const usage = describeModelStatus(
      status({
        kind: "paused",
        limits: [
          {
            model: "openai-codex/gpt-6-sol",
            account: "Claude account",
            kind: "usage",
            retryAt: NOW,
          },
          {
            model: "claude-subscription/opus-5.5",
            account: "Claude account",
            kind: "weekly",
            retryAt: NOW,
          },
        ],
      }),
      "Worker",
      TZ,
    );
    expect(usage.title).toContain("This Claude account ran out of usage");
    expect(usage.lines).toContain("Worker is paused: every fallback is out too.");
    expect(usage.lines[1]).toContain("weekly usage limit");
  });

  it("renders the return notice and nothing without a status", () => {
    const html = renderToStaticMarkup(
      <ModelStatusBanner status={status({ kind: "returned" })} botName="Worker" timeZone={TZ} />,
    );
    expect(html).toContain("Worker is back on openai-codex/gpt-6-sol.");
    expect(html).toContain('role="status"');
    expect(renderToStaticMarkup(<ModelStatusBanner status={undefined} botName="W" />)).toBe("");
  });
});

describe("fallback editor", () => {
  const providers: ProviderModels[] = [
    {
      id: "openai",
      name: "OpenAI",
      models: [
        { id: "a", name: "A", reasoning: false, contextWindow: 1 },
        { id: "b", name: "B", reasoning: false, contextWindow: 1 },
      ],
    },
  ];
  const profile = { id: "p", name: "P", main: "openai/a", pool: [] };

  it("lists fallbacks in order with reorder controls", () => {
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={{ ...profile, fallbacks: ["openai/b", "gone/c"] }}
        providers={providers}
        onSave={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Fallback 1"');
    expect(html).toContain("gone/c (not signed in)");
    expect(html).toContain("Move fallback 2 up");
    expect(html).toContain("Add fallback");
  });

  it("caps fallbacks and flags the main model or duplicates", () => {
    const full = renderToStaticMarkup(
      <ProfileEditor
        profile={{
          ...profile,
          fallbacks: Array.from({ length: MAX_FALLBACKS }, (_, i) => `x/${i}`),
        }}
        providers={providers}
        onSave={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(full).not.toContain("Add fallback");
    const bad = renderToStaticMarkup(
      <ProfileEditor
        profile={{ ...profile, fallbacks: ["openai/a"] }}
        providers={providers}
        onSave={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(bad).toContain("A fallback can&#x27;t be the main model.");
  });
});

describe("message errors", () => {
  it("styles a failed reply like the error notice", () => {
    const html = renderToStaticMarkup(<MessageError message="429 rate limited" />);
    expect(html).toContain('class="notice error message-error"');
    expect(html).toContain("Reply failed");
    expect(html).toContain("429 rate limited");
  });
});
