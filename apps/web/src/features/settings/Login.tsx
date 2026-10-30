import { CircleAlert, CircleCheck, Copy, ExternalLink, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { LoginEvent, LoginPrompt } from "../../protocol.ts";

export type LoginState = {
  loginId: string;
  accountId: string;
  label: string;
  /** Sign-in variant requested, if not the account's default. */
  method?: string;
  events: LoginEvent[];
};

/** Fold the event log into what the panel shows now. */
export function loginView(events: readonly LoginEvent[]) {
  let authUrl: Extract<LoginEvent, { kind: "auth_url" }> | undefined;
  let deviceCode: Extract<LoginEvent, { kind: "device_code" }> | undefined;
  let status: "running" | "done" | "error" = "running";
  let error: string | undefined;
  let message: string | undefined;
  const prompts = new Map<string, LoginPrompt>();
  for (const event of events) {
    if (event.kind === "auth_url") authUrl = event;
    else if (event.kind === "device_code") deviceCode = event;
    else if (event.kind === "prompt") prompts.set(event.promptId, event.prompt);
    else if (event.kind === "prompt_closed") prompts.delete(event.promptId);
    else if (event.kind === "info" || event.kind === "progress") message = event.message;
    else if (event.kind === "done") status = "done";
    else if (event.kind === "error") {
      status = "error";
      error = event.message;
    }
  }
  const open = [...prompts].at(-1);
  return {
    authUrl,
    deviceCode,
    status,
    error,
    message,
    prompt: status === "running" && open ? { promptId: open[0], prompt: open[1] } : undefined,
  };
}

function PromptForm({
  prompt,
  onRespond,
}: {
  prompt: LoginPrompt;
  onRespond: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  if (prompt.type === "select") {
    return (
      <div className="login-step">
        <p>{prompt.message}</p>
        <div className="login-options">
          {prompt.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="secondary login-option"
              onClick={() => onRespond(option.id)}
            >
              <span>{option.label}</span>
              {option.description ? <small className="muted">{option.description}</small> : null}
            </button>
          ))}
        </div>
      </div>
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) onRespond(value);
  }
  return (
    <form className="login-step" onSubmit={submit}>
      <label htmlFor="login-prompt">{prompt.message}</label>
      <div className="settings-inline-form">
        <input
          id="login-prompt"
          type={prompt.type === "secret" ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            prompt.placeholder ??
            (prompt.type === "manual_code" ? "Paste the redirect URL or code" : undefined)
          }
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="primary" disabled={!value.trim()}>
          Continue
        </button>
      </div>
    </form>
  );
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** A sign-in in progress: auth URL or device code, the open prompt, and the outcome. */
export function LoginPanel({
  login,
  alternates = [],
  onRespond,
  onCancel,
  onClose,
  onRetry,
}: {
  login: LoginState;
  /** Other sign-in variants, offered when this one fails. */
  alternates?: readonly { id: string; label: string }[];
  onRespond: (promptId: string, value: string) => void;
  onCancel: () => void;
  onClose: () => void;
  onRetry?: (method: string) => void;
}) {
  const view = loginView(login.events);
  const placeholder = view.prompt?.prompt.type === "select" ? "" : view.prompt?.prompt.placeholder;
  // Only a localhost redirect needs copying from the address bar; copy-code pages show the code.
  const localhostRedirect = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(placeholder ?? "");
  return (
    <section className="login-panel" aria-label={`Sign in: ${login.label}`}>
      <div className="login-panel-header">
        <strong>Sign in to {login.label}</strong>
        <button
          type="button"
          className="icon-button"
          aria-label={view.status === "running" ? "Cancel sign-in" : "Close"}
          onClick={view.status === "running" ? onCancel : onClose}
        >
          <Icon icon={X} size={15} weight="control" />
        </button>
      </div>
      {view.deviceCode ? (
        <div className="login-step">
          <p>
            Open{" "}
            <a href={view.deviceCode.verificationUri} target="_blank" rel="noreferrer">
              {view.deviceCode.verificationUri}
            </a>{" "}
            and enter:
          </p>
          <div className="login-code">
            <code>{view.deviceCode.userCode}</code>
            <button
              type="button"
              className="icon-button"
              aria-label="Copy code"
              onClick={() => copy(view.deviceCode?.userCode ?? "")}
            >
              <Icon icon={Copy} size={14} />
            </button>
          </div>
        </div>
      ) : null}
      {view.authUrl ? (
        <div className="login-step">
          {view.authUrl.instructions ? <p>{view.authUrl.instructions}</p> : null}
          <div className="login-url">
            <a className="secondary" href={view.authUrl.url} target="_blank" rel="noreferrer">
              <Icon icon={ExternalLink} size={13} weight="control" />
              Open sign-in page
            </a>
            <button
              type="button"
              className="text-button"
              onClick={() => copy(view.authUrl?.url ?? "")}
            >
              <Icon icon={Copy} size={13} />
              Copy link
            </button>
          </div>
          {localhostRedirect ? (
            <p className="muted">
              It ends on a localhost address that won't load. Paste that full URL below.
            </p>
          ) : null}
        </div>
      ) : null}
      {view.prompt ? (
        <PromptForm
          key={view.prompt.promptId}
          prompt={view.prompt.prompt}
          onRespond={(value) => view.prompt && onRespond(view.prompt.promptId, value)}
        />
      ) : null}
      {view.status === "running" && !view.prompt ? (
        <Loading label={view.message ?? "Waiting for the provider…"} />
      ) : null}
      {view.status === "done" ? (
        <div className="notice success" role="status">
          <Icon icon={CircleCheck} size={16} />
          <span>Signed in.</span>
        </div>
      ) : null}
      {view.status === "error" ? (
        <div className="notice error" role="alert">
          <Icon icon={CircleAlert} size={16} />
          <span>{view.error}</span>
        </div>
      ) : null}
      {view.status === "error" && onRetry && alternates.length ? (
        <p className="account-alternates">
          Try instead
          {alternates.map((method) => (
            <button
              key={method.id}
              type="button"
              className="link-button"
              onClick={() => onRetry(method.id)}
            >
              {method.label}
            </button>
          ))}
        </p>
      ) : null}
    </section>
  );
}
