import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrchestratorPanel } from "../src/features/settings/Orchestrator.tsx";

const alpha = { id: "a", name: "Alpha", createdAt: "2026-01-01T00:00:00Z" };
const beta = { id: "b", name: "Beta", createdAt: "2026-01-02T00:00:00Z" };

describe("OrchestratorPanel", () => {
  it("says a single bot orchestrates itself", () => {
    const html = renderToStaticMarkup(
      <OrchestratorPanel
        bots={[alpha]}
        status={{ botId: "a", source: "single", needsConfirmation: false }}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain("only bot");
    expect(html).not.toContain("<select");
  });

  it("asks to confirm the first-created default with two or more bots", () => {
    const html = renderToStaticMarkup(
      <OrchestratorPanel
        bots={[alpha, beta]}
        status={{ botId: "a", source: "default", needsConfirmation: true }}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain("<strong>Alpha</strong> (created first)");
    expect(html).toContain("Confirm");
    expect(html).toContain('<option value="b">Beta</option>');
  });

  it("shows a confirmed choice without the prompt", () => {
    const html = renderToStaticMarkup(
      <OrchestratorPanel
        bots={[alpha, beta]}
        status={{ botId: "b", source: "configured", needsConfirmation: false }}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain("<strong>Beta</strong> orchestrates");
    expect(html).not.toContain("Confirm");
  });
});
