import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type TomlScalar = string | number | boolean;
export type TomlEdit = { readonly path: readonly string[]; readonly value: TomlScalar };

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function keyText(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function valueText(value: TomlScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("TOML numbers must be finite");
    return String(value);
  }
  return value ? "true" : "false";
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Normalized `[a.b]` header name, or undefined if the line is not a plain table header. */
function headerName(line: string): string | undefined {
  const match = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
  if (!match?.[1]) return undefined;
  return match[1]
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .join(".");
}

function lookup(doc: unknown, path: readonly string[]): unknown {
  let current = doc;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Line-level edit that keeps comments and layout. May leave the document unchanged. */
function editLines(text: string, edit: TomlEdit): string {
  const lines = text.split("\n");
  const key = edit.path.at(-1);
  if (!key) throw new Error("empty TOML path");
  const table = edit.path.slice(0, -1).join(".");
  const assignment = `${keyText(key)} = ${valueText(edit.value)}`;
  const keyPattern = new RegExp(
    `^(\\s*(?:${escapeRegExp(key)}|"${escapeRegExp(key)}")\\s*=\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s#]+)(\\s*(?:#.*)?)$`,
  );

  // Section bounds: [start, end) of the body of `table` ("" is the root, before any header).
  let start = table === "" ? 0 : -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const name = headerName(lines[index] ?? "");
    if (name === undefined && !/^\s*\[\[/.test(lines[index] ?? "")) continue;
    if (start >= 0) {
      end = index;
      break;
    }
    if (name === table) start = index + 1;
  }
  if (start < 0) {
    const trimmed = text.replace(/\s*$/, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}[${edit.path.slice(0, -1).map(keyText).join(".")}]\n${assignment}\n`;
  }
  for (let index = start; index < end; index += 1) {
    const match = keyPattern.exec(lines[index] ?? "");
    if (match) {
      lines[index] = `${match[1]}${valueText(edit.value)}${match[2] ?? ""}`;
      return lines.join("\n");
    }
  }
  let insertAt = end;
  while (insertAt > start && /^\s*(#.*)?$/.test(lines[insertAt - 1] ?? "")) insertAt -= 1;
  lines.splice(insertAt, 0, assignment);
  return lines.join("\n");
}

/**
 * Set scalar values in a TOML document, keeping comments and layout where possible. Falls back to
 * re-serializing the parsed document (comments lost) when the key lives somewhere a line edit
 * can't reach, e.g. an inline table. Throws on invalid input TOML.
 */
export function setTomlValues(text: string, edits: readonly TomlEdit[]): string {
  let next = text;
  for (const edit of edits) {
    const candidate = editLines(next, edit);
    let ok = false;
    try {
      ok = lookup(parseToml(candidate), edit.path) === edit.value;
    } catch {
      ok = false;
    }
    if (ok) {
      next = candidate;
      continue;
    }
    const doc = parseToml(next) as Record<string, unknown>;
    let cursor: Record<string, unknown> = doc;
    for (const part of edit.path.slice(0, -1)) {
      const child = cursor[part];
      if (child === undefined) cursor[part] = {};
      else if (!child || typeof child !== "object" || Array.isArray(child)) {
        throw new Error(`${edit.path.join(".")}: ${part} is not a table`);
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[edit.path.at(-1) as string] = edit.value;
    next = `${stringifyToml(doc)}\n`;
  }
  return next;
}
