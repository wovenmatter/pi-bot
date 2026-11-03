import { Trash2 } from "lucide-react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { AccountStatus, SearchProviderId } from "../../protocol.ts";
import { AccountHelp } from "./Accounts.tsx";
import { KeyForm } from "./shared.tsx";

/** Web search keys and the default provider. */
export function SearchSettings({
  search,
  disabled,
  onSetDefault,
  onSaveKey,
  onRemove,
}: {
  search: { provider: SearchProviderId; providers: AccountStatus[] } | undefined;
  disabled?: boolean;
  onSetDefault: (provider: SearchProviderId) => void;
  onSaveKey: (account: AccountStatus, key: string) => Promise<boolean>;
  onRemove: (account: AccountStatus) => void;
}) {
  if (!search) return <Loading />;
  const configured = search.providers.filter((provider) => provider.configured);
  const selected = configured.find((provider) => provider.id === search.provider) ?? configured[0];
  return (
    <section className="settings-section" aria-labelledby="search-keys-heading">
      <h3 id="search-keys-heading">Keys</h3>
      <p className="muted">
        Save one API key per provider. Select a saved key to use for web search.
      </p>
      <ul className="settings-list">
        {search.providers.map((provider) => (
          <li key={provider.id} className="settings-row search-key-row">
            <div className="search-key-selector">
              {provider.configured ? (
                <input
                  type="radio"
                  name="search-provider"
                  aria-label={`Use ${provider.label} for web search`}
                  checked={selected?.id === provider.id}
                  disabled={disabled}
                  onChange={() => onSetDefault(provider.id as SearchProviderId)}
                />
              ) : null}
            </div>
            <div className="account-row search-key-content">
              <div className="account-row-main">
                <div className="settings-row-text">
                  <strong>{provider.label}</strong>
                  <small
                    className={provider.configured ? "account-status configured" : "account-status"}
                  >
                    <span className="status-dot" aria-hidden="true" />
                    {provider.detail ?? (provider.configured ? "Configured" : "Not set")}
                  </small>
                </div>
                {(provider.configured || provider.unreadable) && !provider.ambient ? (
                  <button
                    type="button"
                    className="text-button danger"
                    aria-label={`Remove ${provider.label}`}
                    disabled={disabled}
                    onClick={() => onRemove(provider)}
                  >
                    <Icon icon={Trash2} size={13} />
                    Remove
                  </button>
                ) : null}
              </div>
              <KeyForm
                label={`${provider.label} API key`}
                placeholder={
                  provider.configured ? "Paste a new key to replace it" : "Paste API key"
                }
                disabled={disabled}
                onSave={(key) => onSaveKey(provider, key)}
              />
              <div className="account-meta">
                <AccountHelp help={provider.help} link={provider.link} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
