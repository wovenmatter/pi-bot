import type { Element, ElementContent } from "hast";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon.tsx";

function textOf(node?: Element | ElementContent): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
}

function CopyText({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="utility-button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon icon={copied ? Check : Copy} size={12} weight="control" />
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const code = node?.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  const classes = code?.properties?.className;
  const language = Array.isArray(classes)
    ? classes
        .map(String)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length)
    : undefined;
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language || "Code"}</span>
        <CopyText label="Copy code" text={textOf(code ?? node).replace(/\n$/, "")} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

// Stable renderer identities, as in Enterprise RichText: inline factories would remount blocks.
const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="muted">{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
  pre: CodeBlock,
  table: ({ children }) => (
    <div className="markdown-table">
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    </div>
  ),
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <span
        className={`task-marker${checked ? " checked" : ""}`}
        role="img"
        aria-label={checked ? "Completed" : "Not completed"}
      />
    ) : null,
};

/** Assistant markdown: GFM, raw HTML skipped, links open in a new tab, images never fetched. */
export function RichText({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {children}
      </Markdown>
    </div>
  );
}
