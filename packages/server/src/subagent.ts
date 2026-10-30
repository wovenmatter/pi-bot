import {
  AssistantEntry,
  type ConversationId,
  configure,
  defineExtension,
  defineTool,
  type Extension,
  section,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { backgroundModel, type PoolModel, type Profile, parseModelRef } from "./config.ts";

export const SUBAGENT_EXTENSION = "pi-bot-subagent";

/** The `run_subagent` model alias for the profile's background model. */
const BACKGROUND = "background";

/** Reasoning levels `run_subagent` accepts (Pi Durable's thinking levels). */
export const SUBAGENT_REASONING = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type SubagentLog = (event: {
  readonly phase: "start" | "done" | "failed";
  readonly model: string;
  readonly reasoning?: string;
  readonly detail?: string;
}) => void;

export type SubagentOptions = {
  /** The bot's live profile: the pool is read at every call. */
  readonly profile: () => Profile;
  /** Extensions the child must not have, besides this one (bot tools, the bot's own preamble). */
  readonly removeFromChild?: readonly Extension[];
  readonly log?: SubagentLog;
};

const CHILD_INSTRUCTIONS =
  "You are a subagent doing one self-contained task for another assistant. Do the task with the tools you have, then reply with the complete result: your reply is all the other assistant gets back, so include everything it needs and nothing else.";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
const fail = (text: string): Result => ({ output: [{ type: "text", text }], isError: true });

/** The section that tells the main model about its pool. */
export function poolSection(profile: Profile): string | undefined {
  if (profile.pool.length === 0) return undefined;
  const lines = [
    `Your model profile is "${profile.name}". You can hand self-contained work to these pool models with run_subagent; each runs separately with your tools but none of your conversation, so give it everything it needs in the task:`,
    ...profile.pool.map(
      (entry) =>
        `- ${entry.model}${entry.useFor ? `: ${entry.useFor}` : ""}${entry.background ? " (background model)" : ""}`,
    ),
    "Pick the model and reasoning level that fit the task (cheaper for simple work). Independent subagents can run at once. If a call fails, pick another pool model or do the work yourself.",
    `For background work (housekeeping, summaries nobody waits for), use model "background": ${backgroundModel(profile)}.`,
    'If a pool model hit a usage limit, ran out of credits or is rate limited, quietly use another suitable pool model (or do the work yourself) and tell the user in one short line, e.g. "I couldn\'t use <model>, so I used <other model> instead." Say only what the error said; do not guess when a limit resets.',
  ];
  if (profile.guidance) lines.push(`Guidance: ${profile.guidance}`);
  return lines.join("\n");
}

/**
 * The pool entry `run_subagent` runs for `model`. `"background"` is the profile's background
 * model: its pool entry flagged `background`, else the main model.
 */
export function subagentModel(profile: Profile, model: string): PoolModel | undefined {
  if (model === BACKGROUND) {
    const ref = backgroundModel(profile);
    return (
      profile.pool.find((entry) => entry.model === ref) ?? {
        model: ref,
        useFor: "",
        background: true,
      }
    );
  }
  return profile.pool.find((entry) => entry.model === model);
}

/**
 * `run_subagent`: run one task on a model from the bot's profile pool in a child conversation
 * owned by the call, and return its answer. The child is a separate conversation, so the main
 * model's context and prompt cache are untouched. No fallback: a failure is returned as a tool
 * error and the main model picks another model.
 */
export function subagentExtension(options: SubagentOptions): Extension {
  const extension: Extension = defineExtension({
    name: SUBAGENT_EXTENSION,
    sections: [section("model_pool", () => poolSection(options.profile()))],
    tools: [
      defineTool({
        name: "run_subagent",
        description:
          "Run a self-contained task on a model from your profile's pool and get its complete answer back. The subagent has your tools but not this conversation: include all context in task.",
        parameters: Type.Object({
          model: Type.String({
            description:
              'A pool model, provider/model-id, or "background" for the profile\'s background model',
          }),
          reasoning: Type.Optional(
            Type.Union(
              SUBAGENT_REASONING.map((level) => Type.Literal(level)),
              {
                description: "Reasoning level (default: the model's default)",
              },
            ),
          ),
          task: Type.String({ description: "The complete task, with all context it needs" }),
        }),
        replay: "safe",
        executionMode: "parallel",
        execute: async (args, api, context) => {
          const profile = options.profile();
          const entry = subagentModel(profile, args.model);
          if (!entry) {
            return fail(
              profile.pool.length
                ? `${args.model} is not in your pool. Pool models: ${profile.pool.map((pool) => pool.model).join(", ")}.`
                : "Your profile has no pool models; do the work yourself.",
            );
          }
          const model = parseModelRef(entry.model);
          const log = (phase: "start" | "done" | "failed", detail?: string) =>
            options.log?.({
              phase,
              model: entry.model,
              ...(args.reasoning ? { reasoning: args.reasoning } : {}),
              ...(detail ? { detail } : {}),
            });
          log("start");
          try {
            const child = await api.commit(async (tx): Promise<ConversationId> => {
              const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1))
                .items[0];
              if (existing !== undefined) return existing.id;
              const created = await tx.createConversation({
                ownership: { kind: "task", taskId: api.taskId },
              });
              await configure(tx, created.id, {
                model,
                thinkingLevel: args.reasoning ?? null,
                instructions: CHILD_INSTRUCTIONS,
                extensions: { remove: [extension, ...(options.removeFromChild ?? [])] },
              });
              return created.id;
            }, context);
            await api.details({ conversationId: child, model: entry.model }, context);
            const handle = await api.conversation(child, context);
            if (!handle) throw new Error("the subagent conversation is missing");
            const submission = await handle.submit(
              { type: "input", content: args.task, requestId: `subagent:${api.taskId}` },
              context,
            );
            const settled = await submission.wait(context);
            if (settled.status !== "done" || settled.type !== "input") {
              const reason =
                settled.status === "unanswered"
                  ? `${settled.reason}${settled.detail !== undefined ? ` (${JSON.stringify(settled.detail)})` : ""}`
                  : settled.status;
              log("failed", reason);
              return fail(
                `Subagent on ${entry.model} failed: ${reason}. Pick another pool model or do it yourself.`,
              );
            }
            const answerId = settled.answer;
            const answer = await api.commit((tx) => tx.entry(AssistantEntry, answerId), context);
            const message = answer?.model?.[0];
            const stop = message && "stopReason" in message ? String(message.stopReason ?? "") : "";
            if (stop === "error" || stop === "aborted") {
              const error =
                message && "errorMessage" in message && message.errorMessage
                  ? String(message.errorMessage)
                  : stop;
              log("failed", error);
              return fail(
                `Subagent on ${entry.model} failed: ${error}. Pick another pool model or do it yourself.`,
              );
            }
            const content = message && "content" in message ? message.content : [];
            const text = (Array.isArray(content) ? content : [])
              .flatMap((part) =>
                part && typeof part === "object" && "type" in part && part.type === "text"
                  ? [String((part as { text?: unknown }).text ?? "")]
                  : [],
              )
              .join("")
              .trim();
            log("done");
            return { output: [{ type: "text", text: text || "(the subagent returned no text)" }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log("failed", message);
            return fail(
              `Subagent on ${entry.model} failed: ${message}. Pick another pool model or do it yourself.`,
            );
          }
        },
      }),
    ],
  });
  return extension;
}
