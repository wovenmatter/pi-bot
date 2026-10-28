// Pi Bot environment agent. Runs inside a bot's container (as the non-root `bot` user) and serves
// Pi Durable's Node execution environment over stdio, one JSON message per line, so the server's
// tools (bash, read, write, edit) execute here instead of on the host. It holds no credentials.
//
// In:  { id, cwd, handle?, method, args }   call a method on the env for `cwd` or on a handle
//      { id, cancel: true }                 abort that call's context
// Out: { id, value } | { id, thrown }      the call's result (Results stay Results)
//      { callback, args }                   invoke a host callback (exec output, watch changes)
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const envs = new Map();
const handles = new Map();
const calls = new Map();
let nextHandle = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function envFor(cwd) {
  const key = typeof cwd === "string" && cwd ? cwd : "/workspace";
  let env = envs.get(key);
  if (!env) {
    env = new NodeExecutionEnv({ cwd: key });
    envs.set(key, env);
  }
  return env;
}

function isContext(value) {
  return typeof value.value === "function" && "telemetry" in value && "abortSignal" in value;
}

function encode(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) {
    return {
      $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  }
  if (value instanceof FileError) {
    return { $error: { kind: "file", code: value.code, message: value.message, path: value.path } };
  }
  if (value instanceof ExecutionError) {
    return {
      $error: {
        kind: "exec",
        code: value.code,
        message: value.message,
        spillPath: value.spillPath,
      },
    };
  }
  if (value instanceof Error) return { $error: { kind: "error", message: value.message } };
  if (Array.isArray(value)) return value.map(encode);
  if (isContext(value)) return { $ctx: 1 };
  if (typeof value.close === "function") {
    const id = nextHandle++;
    handles.set(id, value);
    return { $handle: id, ...(typeof value.mode === "string" ? { mode: value.mode } : {}) };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "function") out[key] = encode(item);
  }
  return out;
}

function decode(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value.$bytes === "string") return new Uint8Array(Buffer.from(value.$bytes, "base64"));
  if (typeof value.$callback === "number") {
    const token = value.$callback;
    return (...args) => send({ callback: token, args: args.map(encode) });
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = decode(item);
  return out;
}

async function call(message) {
  const controller = new AbortController();
  calls.set(message.id, controller);
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  try {
    const target = message.handle ? handles.get(message.handle) : envFor(message.cwd);
    if (!target) throw new Error(`unknown handle ${message.handle}`);
    const method = String(message.method);
    const fn = target[method];
    if (method.startsWith("_") || method === "constructor" || typeof fn !== "function") {
      throw new Error(`unknown method ${method}`);
    }
    const args = Array.isArray(message.args)
      ? message.args.map((arg) => (arg === null ? undefined : decode(arg)))
      : [];
    const value = await fn.apply(target, [...args, context]);
    if (message.handle && method === "close") handles.delete(message.handle);
    send({ id: message.id, value: encode(value) });
  } catch (error) {
    send({ id: message.id, thrown: error instanceof Error ? error.message : String(error) });
  } finally {
    calls.delete(message.id);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("pi-bot env agent: invalid message\n");
    return;
  }
  if (message.cancel) {
    calls.get(message.id)?.abort(new Error("cancelled"));
    return;
  }
  void call(message);
});
lines.on("close", async () => {
  for (const env of envs.values()) await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
  process.exit(0);
});
send({ ready: true });
