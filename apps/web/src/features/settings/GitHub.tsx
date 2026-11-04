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
  onSaveIdentity: (identity: { name: string }) => Promise<boolean>;
}) {
  const [pasting, setPasting] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<{ name: string }>();
  if (!status) return <Loading />;
  const value = identity ?? {
    name: status.identity.name ?? "",
  };
  const identityChanged = value.name !== (status.identity.name ?? "");

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
      if (await onSaveIdentity({ name: value.name.trim() })) setIdentity(undefined);
    });
  }
  const off = disabled || busy;

  return (
    <>
      <section className="settings-section" aria-labelledby="ssh-heading">
        <h3 id="ssh-heading">Shared SSH key</h3>
        <p className="muted">
          One shared SSH key lets all your bots clone, pull, and push repositories. Generate a
          dedicated key, then add its public half to GitHub to grant access. Pi Bot stores the
          private half securely and never displays it.
        </p>
        {status.sshKey ? (
          <div className="ssh-key">
            <p className="muted">
              Copy the public key below, then open{" "}
              <a href="https://github.com/settings/ssh/new" target="_blank" rel="noreferrer">
                GitHub → New SSH key
              </a>{" "}
              on the account your bots should use. Choose Authentication Key, paste it into Key, and
              click Add SSH key. All your bots share that account's repository access.{" "}
              <a
                href="https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account"
                target="_blank"
                rel="noreferrer"
              >
                Setup guide
              </a>
            </p>
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
          Author name on commits made by all your bots. This does not change GitHub notifications.
        </p>
        <div className="settings-fields">
          <label className="settings-field">
            <span>Name</span>
            <input
              type="text"
              autoComplete="off"
              value={value.name}
              disabled={off}
              onChange={(event) => setIdentity({ ...value, name: event.target.value })}
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
