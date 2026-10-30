import { LogIn, LogOut, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { AccountStatus } from "../../protocol.ts";
import { LoginPanel, type LoginState } from "./Login.tsx";
import { KeyForm } from "./shared.tsx";

export type AccountActions = {
  onSaveKey: (account: AccountStatus, key: string) => Promise<boolean>;
  onRemove: (account: AccountStatus) => void;
  /** `method`: one of `account.loginMethods`; omitted means the default (first). */
  onSignIn: (account: AccountStatus, method?: string) => void;
  onRespond: (promptId: string, value: string) => void;
  onCancelLogin: () => void;
  onCloseLogin: () => void;
};

function statusText(account: AccountStatus): string {
  if (account.detail) return account.detail;
  if (account.configured) return "Configured";
  return account.method === "oauth" ? "Not signed in" : "Not set";
}

/** Longer than this, provider help folds away under "How it works". */
const SHORT_HELP = 90;

/** Short help stays inline; longer provider instructions fold away until asked for. */
export function AccountHelp({ help, link }: { help: string; link?: string }) {
  const getKey = link ? (
    <a href={link} target="_blank" rel="noreferrer">
      Get a key
    </a>
  ) : null;
  if (help.length <= SHORT_HELP) {
    return (
      <span className="account-help">
        {help} {getKey}
      </span>
    );
  }
  return (
    <>
      <details className="account-help">
        <summary>How it works</summary>
        <p>{help}</p>
      </details>
      {getKey}
    </>
  );
}

/** One sign-in slot: status (never the key itself) and its action. */
export function AccountRow({
  account,
  login,
  disabled,
  actions,
  apiKeys = [],
}: {
  account: AccountStatus;
  login?: LoginState;
  disabled?: boolean;
  actions: AccountActions;
  /** API keys offered instead of this sign-in, folded under "Use an API key instead". */
  apiKeys?: readonly AccountStatus[];
}) {
  const keyed = account.method !== "oauth";
  const alternates = account.loginMethods?.slice(1) ?? [];
  return (
    <li className="settings-row account-row">
      <div className="account-row-main">
        <div className="settings-row-text">
          <strong>{account.label}</strong>
          <small className={account.configured ? "account-status configured" : "account-status"}>
            <span className="status-dot" aria-hidden="true" />
            {statusText(account)}
          </small>
        </div>
        <div className="account-row-actions">
          {account.configured && !account.ambient ? (
            <button
              type="button"
              className="text-button danger"
              aria-label={`${keyed ? "Remove" : "Sign out of"} ${account.label}`}
              disabled={disabled}
              onClick={() => actions.onRemove(account)}
            >
              <Icon icon={keyed ? Trash2 : LogOut} size={13} />
              {keyed ? "Remove" : "Sign out"}
            </button>
          ) : null}
          {keyed ? null : (
            <button
              type="button"
              className="secondary"
              disabled={disabled || login !== undefined}
              onClick={() => actions.onSignIn(account)}
            >
              <Icon icon={LogIn} size={13} weight="control" />
              {account.configured ? "Sign in again" : (account.signInLabel ?? "Sign in")}
            </button>
          )}
        </div>
      </div>
      {keyed ? (
        <KeyForm
          label={
            /\b(API key|token)$/.test(account.label)
              ? account.label
              : `${account.label} ${account.method === "token" ? "token" : "API key"}`
          }
          placeholder={
            account.configured
              ? "Paste a new value to replace it"
              : account.method === "token"
                ? "Paste token"
                : "Paste API key"
          }
          disabled={disabled}
          onSave={(key) => actions.onSaveKey(account, key)}
        />
      ) : null}
      <div className="account-meta">
        <AccountHelp help={account.help} link={account.link} />
        {!keyed && !login && alternates.length ? (
          <span className="account-alternates">
            Or sign in with
            {alternates.map((method) => (
              <button
                key={method.id}
                type="button"
                className="link-button"
                disabled={disabled}
                onClick={() => actions.onSignIn(account, method.id)}
              >
                {method.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {login ? (
        <LoginPanel
          login={login}
          alternates={(account.loginMethods ?? []).filter(
            (method) => method.id !== (login.method ?? account.loginMethods?.[0]?.id),
          )}
          onRespond={actions.onRespond}
          onCancel={actions.onCancelLogin}
          onClose={actions.onCloseLogin}
          onRetry={(method) => actions.onSignIn(account, method)}
        />
      ) : null}
      {apiKeys.length ? (
        // Collapsed until asked for, or while a key is set (so it can be seen and removed).
        <details
          className="account-help account-api-key"
          open={apiKeys.some((key) => key.configured) || undefined}
        >
          <summary>Use an API key instead</summary>
          <ul className="settings-list">
            {apiKeys.map((key) => (
              <AccountRow key={key.id} account={key} disabled={disabled} actions={actions} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** Plans and budget (account notes): plans, tiers and rough monthly comfort spend. Guidance for Admin Bot. */
export function AccountNotes({
  notes,
  disabled,
  onSave,
}: {
  notes: string | undefined;
  disabled?: boolean;
  onSave: (notes: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (notes === undefined) return <Loading />;
  const value = draft ?? notes;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(value);
      setDraft(undefined);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="settings-section"
      aria-labelledby="account-notes-heading"
      onSubmit={(event) => void submit(event)}
    >
      <h3 id="account-notes-heading">Plans and budget</h3>
      <p className="muted">
        What you subscribe to and roughly what you're comfortable spending. Admin Bot reads this
        when it picks models. Guidance, not hard limits, and never put keys here.
      </p>
      <textarea
        aria-label="Account notes"
        rows={4}
        value={value}
        disabled={disabled || saving}
        placeholder="e.g. ChatGPT Pro ($200/mo), Claude Max ($100/mo), OpenRouter key: ~$50/month is fine"
        onChange={(event) => setDraft(event.target.value)}
      />
      {value !== notes ? (
        <div className="settings-actions">
          <button type="submit" className="primary" disabled={disabled || saving}>
            {saving ? "Saving…" : "Save notes"}
          </button>
          <button type="button" className="text-button" onClick={() => setDraft(undefined)}>
            Reset
          </button>
        </div>
      ) : null}
    </form>
  );
}

/** Accounts: provider sign-ins and keys, grouped by provider. */
export function AccountsList({
  accounts,
  login,
  disabled,
  actions,
}: {
  accounts: readonly AccountStatus[] | undefined;
  login?: LoginState;
  disabled?: boolean;
  actions: AccountActions;
}) {
  if (!accounts) return <Loading />;
  const ids = new Set(accounts.map((account) => account.id));
  // An API key that is the alternative to a sign-in folds under that sign-in's row.
  const folded = (account: AccountStatus) =>
    account.alternateTo !== undefined && ids.has(account.alternateTo);
  const groups = new Map<string, AccountStatus[]>();
  for (const account of accounts) {
    if (folded(account)) continue;
    groups.set(account.group, [...(groups.get(account.group) ?? []), account]);
  }
  return (
    <>
      {[...groups].map(([group, items]) => (
        <section key={group} className="settings-section" aria-label={group}>
          <h3>{group}</h3>
          <ul className="settings-list">
            {items.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                login={login?.accountId === account.id ? login : undefined}
                disabled={disabled}
                actions={actions}
                apiKeys={accounts.filter((key) => key.alternateTo === account.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
