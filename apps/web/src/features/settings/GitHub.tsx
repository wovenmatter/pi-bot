import { Copy, KeyRound, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { GitHubStatus } from "../../protocol.ts";

/** GitHub SSH key (public half only, private half write-only) and git identity. */
export function GitHubSettings({
  status,
  disabled,
  onGenerate,
  onPaste,
  onRemove,
  onSaveIdentity,
}: {
  status: GitHubStatus | undefined;
  disabled?: boolean;
  onGenerate: () => Promise<void>;
  onPaste: (privateKey: string) => Promise<boolean>;
  onRemove: () => void;
  onSaveIdentity: (identity: { name: string; email: string }) => Promise<boolean>;
}) {
  const [pasting, setPasting] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<{ name: string; email: string }>();
  if (!status) return <Loading />;
  const value = identity ?? {
    name: status.identity.name ?? "",
    email: status.identity.email ?? "",
  };
  const identityChanged =
    value.name !== (status.identity.name ?? "") || value.email !== (status.identity.email ?? "");

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }
  function paste(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (await onPaste(privateKey)) {
        setPrivateKey("");
        setPasting(false);
      }
    });
  }
  function saveIdentity(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (await onSaveIdentity({ name: value.name.trim(), email: value.email.trim() }))
        setIdentity(undefined);
    });
  }
  const off = disabled || busy;

  return (
    <>
      <section className="settings-section" aria-labelledby="ssh-heading">
        <h3 id="ssh-heading">Shared SSH key</h3>
        <p className="muted">Shared by all your bots to clone, pull, and push repositories.</p>
        {status.sshKey ? (
          <div className="ssh-key">
            <div className="settings-row-text">
              <strong>{status.sshKey.comment ?? status.sshKey.type}</strong>
              <small className="account-status configured">
                <code>{status.sshKey.fingerprint}</code>
              </small>
            </div>
            <textarea
              className="ssh-public-key"
              aria-label="Public key"
              readOnly
              rows={3}
              value={status.sshKey.publicKey}
            />
            <div className="settings-actions">
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(status.sshKey?.publicKey ?? "")
                    .catch(() => {})
                }
              >
                <Icon icon={Copy} size={13} />
                Copy public key
              </button>
              <a href="https://github.com/settings/ssh/new" target="_blank" rel="noreferrer">
                Add key on GitHub ↗
              </a>
              <button
                type="button"
                className="text-button danger"
                disabled={off}
                onClick={onRemove}
              >
                <Icon icon={Trash2} size={13} />
                Remove key
              </button>
            </div>
          </div>
        ) : (
          <p className="settings-empty muted">No SSH key stored.</p>
        )}
        <div className="settings-actions">
          <button
            type="button"
            className="primary"
            disabled={off}
            onClick={() => void run(onGenerate)}
          >
            <Icon icon={KeyRound} size={13} weight="control" />
            {status.sshKey ? "Replace with a new key" : "Generate a key"}
          </button>
          {pasting ? null : (
            <button
              type="button"
              className="text-button"
              disabled={off}
              onClick={() => setPasting(true)}
            >
              Paste an existing private key
            </button>
          )}
        </div>
        {pasting ? (
          <form className="ssh-paste" onSubmit={paste}>
            <textarea
              aria-label="Private key"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              autoComplete="off"
              spellCheck={false}
              rows={6}
              value={privateKey}
              disabled={off}
              onChange={(event) => setPrivateKey(event.target.value)}
            />
            <div className="settings-actions">
              <button type="submit" className="primary" disabled={off || !privateKey.trim()}>
                Save private key
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setPrivateKey("");
                  setPasting(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </section>
      <form
        className="settings-section"
        aria-labelledby="git-identity-heading"
        onSubmit={saveIdentity}
      >
        <h3 id="git-identity-heading">Git identity</h3>
        <p className="muted">
          Author name and email on commits made by all your bots. Leave email blank to use your
          GitHub account’s noreply address, or bot@pi-bot.invalid if the SSH-linked account is
          unavailable.
        </p>
        <div className="settings-fields">
          <label className="settings-field">
            <span>Name</span>
            <input
              type="text"
              autoComplete="off"
              placeholder="Your name"
              value={value.name}
              disabled={off}
              onChange={(event) => setIdentity({ ...value, name: event.target.value })}
            />
          </label>
          <label className="settings-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="off"
              value={value.email}
              disabled={off}
              placeholder="you@example.com"
              onChange={(event) => setIdentity({ ...value, email: event.target.value })}
            />
          </label>
        </div>
        <div className="settings-actions">
          <button
            type="submit"
            className="primary"
            disabled={off || !identityChanged || !value.name.trim()}
          >
            Save identity
          </button>
        </div>
      </form>
    </>
  );
}
