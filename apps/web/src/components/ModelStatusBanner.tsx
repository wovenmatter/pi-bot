import { CircleAlert, CircleCheck } from "lucide-react";
import type { ModelLimitSummary, ModelStatusSummary } from "../protocol.ts";
import { Icon } from "./Icon.tsx";

/** "Thu, 9:30 PM EDT" in the viewer's own time zone (or the given one, for tests). */
export function formatLocalTime(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** What was hit, in the provider's own terms. Never names a window or reset it didn't report. */
export function describeLimit(limit: ModelLimitSummary): string {
  switch (limit.kind) {
    case "five_hour":
      return `Your ${limit.account} hit its 5-hour usage limit`;
    case "weekly":
      return `Your ${limit.account} hit its weekly usage limit`;
    case "credits":
      return `Your ${limit.account} ran out of credits`;
    default:
      return `This ${limit.account} ran out of usage`;
  }
}

export function describeReset(limit: ModelLimitSummary, timeZone?: string): string {
  return limit.resetsAt !== undefined
    ? `Resets ${formatLocalTime(limit.resetsAt, timeZone)}.`
    : `Reset time not reported; Pi Bot tries again around ${formatLocalTime(limit.retryAt, timeZone)}.`;
}

export type ModelStatusText = {
  tone: "warning" | "error" | "success";
  title: string;
  lines: string[];
};

/** The banner's words for a bot's model status. */
export function describeModelStatus(
  status: ModelStatusSummary,
  botName: string,
  timeZone?: string,
): ModelStatusText {
  if (status.kind === "returned") {
    return {
      tone: "success",
      title: `${botName} is back on ${status.primary}.`,
      lines: ["Its usage limit reset, so Pi Bot switched back from the fallback."],
    };
  }
  const primary = status.limits.find((limit) => limit.model === status.primary) ?? status.limits[0];
  const others = status.limits.filter((limit) => limit !== primary);
  const lines: string[] = [];
  if (primary) lines.push(describeReset(primary, timeZone));
  for (const limit of others) {
    lines.push(
      `Fallback ${limit.model}: ${lowerFirst(describeLimit(limit))}. ${describeReset(limit, timeZone)}`,
    );
  }
  if (status.kind === "paused") {
    lines.push(
      others.length
        ? `${botName} is paused: every fallback is out too.`
        : `${botName} is paused: this profile has no fallback. Add one under Settings → Profiles.`,
    );
  } else {
    lines.push(`${botName} is now using ${status.active} until then.`);
  }
  return {
    tone: status.kind === "paused" ? "error" : "warning",
    title: primary
      ? `${describeLimit(primary)} (${primary.model}).`
      : `${status.primary} is unavailable.`,
    lines,
  };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The prominent notice above a bot's chat while its main model is out or just came back. */
export function ModelStatusBanner({
  status,
  botName,
  timeZone,
  onDismiss,
}: {
  status: ModelStatusSummary | undefined;
  botName: string;
  timeZone?: string;
  onDismiss?: () => void;
}) {
  if (!status) return null;
  const text = describeModelStatus(status, botName, timeZone);
  return (
    <div
      className={`notice model-status ${text.tone}`}
      role={text.tone === "success" ? "status" : "alert"}
    >
      <Icon icon={text.tone === "success" ? CircleCheck : CircleAlert} size={16} />
      <span>
        <strong>{text.title}</strong>
        {text.lines.map((line) => (
          <span key={line} className="model-status-line">
            {line}
          </span>
        ))}
      </span>
      {onDismiss ? (
        <button type="button" className="text-button" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
