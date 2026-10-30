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
  return (
    <>
      <section className="settings-section" aria-labelledby="search-default-heading">
        <h3 id="search-default-heading">Default provider</h3>
        <p className="muted">Used when a bot searches the web.</p>
        <div className="tabs" role="radiogroup" aria-label="Default search provider">
          {search.providers.map((provider) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented control, as in Enterprise
            <button
              key={provider.id}
              type="button"
              role="radio"
              aria-checked={search.provider === provider.id}
              className={search.provider === provider.id ? "active" : undefined}
              disabled={disabled}
              onClick={() => onSetDefault(provider.id as SearchProviderId)}
            >
              {provider.label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section" aria-labelledby="search-keys-heading">
        <h3 id="search-keys-heading">Keys</h3>
        <ul className="settings-list">
          {search.providers.map((provider) => (
            <li key={provider.id} className="settings-row account-row">
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
                {provider.configured && !provider.ambient ? (
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
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
