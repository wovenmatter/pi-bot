import { LogIn, LogOut, Trash2 } from "lucide-react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { AccountStatus } from "../../protocol.ts";
import { LoginPanel, type LoginState } from "./Login.tsx";
import { KeyForm } from "./shared.tsx";

export type AccountActions = {
  onSaveKey: (account: AccountStatus, key: string) => Promise<boolean>;
  onRemove: (account: AccountStatus) => void;
  onSignIn: (account: AccountStatus) => void;
  onRespond: (promptId: string, value: string) => void;
  onCancelLogin: () => void;
  onCloseLogin: () => void;
};

function statusText(account: AccountStatus): string {
  if (account.detail) return account.detail;
  if (account.configured) return "Configured";
  return account.method === "oauth" ? "Not signed in" : "Not set";
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
  return (
    <li className="settings-row account-row">
      <div className="account-row-main">
        <div className="settings-row-text">
          <strong>{account.label}</strong>
          <small className={account.configured ? "account-status configured" : "account-status"}>
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
      <p className="muted account-help">
        {account.help}
        {account.link ? (
          <>
            {" "}
            <a href={account.link} target="_blank" rel="noreferrer">
              Get a key
            </a>
          </>
        ) : null}
      </p>
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
      {login ? (
        <LoginPanel
          login={login}
          onRespond={actions.onRespond}
          onCancel={actions.onCancelLogin}
          onClose={actions.onCloseLogin}
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
