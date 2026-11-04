// jsdom has no layout engine, so this guards the CSS rules that keep the profile editor inside a
// 390px-wide viewport (measured in a real browser): every grid in the chain from the settings
// section down to the pool rows has one shrinkable column, and the editor's controls may shrink.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "..", "src", "styles.css"), "utf8");

/** The declarations of the first top-level rule whose selector list is exactly `selector`. */
function rule(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`no rule for ${selector}`);
  return match[1];
}

describe("profile editor layout", () => {
  it.each([
    ".settings-section",
    ".settings-list",
    ".profile-editor",
    ".profile-section-body",
    ".profile-pool-rows",
  ])("%s has one column that can shrink below its content", (selector) => {
    expect(rule(selector)).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("lets controls and rows shrink instead of widening the editor", () => {
    const shrink = rule(
      ".profile-editor select,\n.profile-editor input,\n.profile-editor textarea,\n.profile-editor-field,\n.profile-section,\n.profile-pool-row > *",
    );
    expect(shrink).toMatch(/min-width:\s*0/);
    expect(shrink).toMatch(/max-width:\s*100%/);
    expect(rule(".profile-section-summary")).toMatch(/min-width:\s*0/);
  });

  it("stacks pool rows on narrow screens", () => {
    const narrow = css.slice(css.indexOf(".profile-pool-row.profile-fallback-row {"));
    const media = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(narrow)?.[1] ?? "";
    expect(media).toMatch(
      /\.profile-pool-row\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/,
    );
    expect(media).toMatch(
      /\.profile-pool-row\s*>\s*\.inline-model-facts\s*\{\s*grid-column:\s*1\s*\/\s*-1;/,
    );
  });
});
