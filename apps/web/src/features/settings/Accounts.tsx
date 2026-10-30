import { LogIn, LogOut, Trash2 } from "lucide-react";
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
}: {
  account: AccountStatus;
  login?: LoginState;
  disabled?: boolean;
  actions: AccountActions;
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
              {account.configured ? "Sign in again" : "Sign in"}
            </button>
          )}
        </div>
      </div>
      {keyed ? (
        <KeyForm
          label={`${account.label} ${account.method === "token" ? "token" : "API key"}`}
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
    </li>
  );
}

/** Account & sign-ins, grouped by provider. */
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
  const groups = new Map<string, AccountStatus[]>();
  for (const account of accounts) {
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
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
