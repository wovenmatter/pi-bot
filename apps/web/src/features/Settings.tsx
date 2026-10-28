import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, type PiBotClient } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { ErrorNotice, Loading } from "../components/ui.tsx";
import type {
  AccountStatus,
  BotSummary,
  DeletedBotSummary,
  GitHubStatus,
  OrchestratorStatus,
  Requests,
} from "../protocol.ts";
import { routeHref, type SettingsSection } from "../routes.ts";
import { type AccountActions, AccountsList } from "./settings/Accounts.tsx";
import { ConfigEditor, LimitsForm, type ValidationState } from "./settings/Config.tsx";
import { GitHubSettings } from "./settings/GitHub.tsx";
import type { LoginState } from "./settings/Login.tsx";
import { ModelSettings } from "./settings/Models.tsx";
import { OrchestratorPanel } from "./settings/Orchestrator.tsx";
import { SearchSettings } from "./settings/Search.tsx";
import { RESTART_TIMEOUT_MS, RestartNotice, type RestartState } from "./settings/shared.tsx";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDeletedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

/** Presentational list of deleted bots; the only place a bot can be restored from. */
export function DeletedBotsList({
  bots,
  restoring,
  disabled,
  onRestore,
}: {
  bots: readonly DeletedBotSummary[] | undefined;
  restoring?: string;
  disabled?: boolean;
  onRestore: (bot: DeletedBotSummary) => void;
}) {
  return (
    <section className="settings-section" aria-labelledby="deleted-bots-heading">
      <h3 id="deleted-bots-heading">Deleted bots</h3>
      <p className="muted">
        Deleted bots keep their conversations and threads. Restore one to bring it back.
      </p>
      {bots === undefined ? (
        <Loading />
      ) : bots.length === 0 ? (
        <p className="settings-empty muted">No deleted bots.</p>
      ) : (
        <ul className="settings-list">
          {bots.map((bot) => (
            <li key={bot.id} className="settings-row">
              <div className="settings-row-text">
                <strong>{bot.name}</strong>
                <small className="muted">
                  Deleted <time dateTime={bot.deletedAt}>{formatDeletedAt(bot.deletedAt)}</time>
                </small>
              </div>
              <button
                type="button"
                className="secondary"
                aria-label={`Restore ${bot.name}`}
                disabled={disabled || restoring !== undefined}
                onClick={() => onRestore(bot)}
              >
                <Icon icon={RotateCcw} size={13} weight="control" />
                {restoring === bot.id ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type SectionProps = {
  client: PiBotClient;
  connected: boolean;
  onError: (message: string | undefined) => void;
  onConfigSaved: () => void;
};

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "accounts", label: "Account & sign-ins" },
  { id: "models", label: "Models" },
  { id: "search", label: "Search" },
  { id: "github", label: "GitHub" },
  { id: "bots", label: "Bots" },
  { id: "config", label: "Config" },
];

function AccountsSection({ client, connected, onError }: SectionProps) {
  const [accounts, setAccounts] = useState<AccountStatus[]>();
  const [login, setLogin] = useState<LoginState>();
  const refresh = useCallback(
    () =>
      client
        .request("settings.accounts", {})
        .then((result) => setAccounts(result.accounts))
        .catch((e: unknown) => onError(errorMessage(e))),
    [client, onError],
  );
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  const loginId = login?.loginId;
  useEffect(() => {
    if (!loginId) return;
    return client.onLogin(loginId, (event) => {
      setLogin((current) =>
        current?.loginId === loginId ? { ...current, events: [...current.events, event] } : current,
      );
      if (event.kind === "done") void refresh();
    });
  }, [client, loginId, refresh]);

  const actions: AccountActions = {
    async onSaveKey(account, key) {
      onError(undefined);
      try {
        await client.request("credentials.set", { accountId: account.id, key });
        await refresh();
        return true;
      } catch (e) {
        onError(errorMessage(e));
        return false;
      }
    },
    onRemove(account) {
      const verb = account.method === "oauth" ? "Sign out of" : "Remove the key for";
      if (!window.confirm(`${verb} ${account.label}?`)) return;
      onError(undefined);
      client
        .request("credentials.remove", { accountId: account.id })
        .then(refresh)
        .catch((e: unknown) => onError(errorMessage(e)));
    },
    onSignIn(account, method) {
      onError(undefined);
      client
        .request("login.start", { accountId: account.id, ...(method ? { method } : {}) })
        .then(({ loginId }) =>
          setLogin({
            loginId,
            accountId: account.id,
            label: account.label,
            ...(method ? { method } : {}),
            events: [],
          }),
        )
        .catch((e: unknown) => onError(errorMessage(e)));
    },
    onRespond(promptId, value) {
      if (!login) return;
      client
        .request("login.respond", { loginId: login.loginId, promptId, value })
        .catch((e: unknown) => onError(errorMessage(e)));
    },
    onCancelLogin() {
      if (!login) return;
      const id = login.loginId;
      setLogin(undefined);
      client.request("login.cancel", { loginId: id }).catch(() => {});
    },
    onCloseLogin() {
      setLogin(undefined);
    },
  };

  return (
    <>
      <p className="muted settings-intro">
        Keys are stored in the credential store and are never shown again; only the last four
        characters appear here. Sign-ins work from any browser: open the link or code shown, then
        paste back what the provider gives you.
      </p>
      <AccountsList accounts={accounts} login={login} disabled={!connected} actions={actions} />
    </>
  );
}

function ModelsSection({ client, connected, onError, onConfigSaved }: SectionProps) {
  const [catalog, setCatalog] = useState<Requests["models.catalog"]["result"]>();
  useEffect(() => {
    if (!connected) return;
    client
      .request("models.catalog", {})
      .then(setCatalog)
      .catch((e: unknown) => onError(errorMessage(e)));
  }, [client, connected, onError]);
  return (
    <ModelSettings
      providers={catalog?.providers}
      roles={catalog?.roles}
      reasoningLevels={catalog?.reasoningLevels ?? []}
      disabled={!connected}
      onSave={async (roles) => {
        onError(undefined);
        try {
          const result = await client.request("models.setRoles", roles);
          setCatalog((current) => (current ? { ...current, roles: result.roles } : current));
          onConfigSaved();
        } catch (e) {
          onError(errorMessage(e));
          throw e;
        }
      }}
    />
  );
}

function SearchSection({ client, connected, onError, onConfigSaved }: SectionProps) {
  const [search, setSearch] = useState<Requests["settings.accounts"]["result"]["search"]>();
  const refresh = useCallback(
    () =>
      client
        .request("settings.accounts", {})
        .then((result) => setSearch(result.search))
        .catch((e: unknown) => onError(errorMessage(e))),
    [client, onError],
  );
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  return (
    <SearchSettings
      search={search}
      disabled={!connected}
      onSetDefault={(provider) => {
        onError(undefined);
        client
          .request("config.update", { edits: [{ path: ["search", "provider"], value: provider }] })
          .then(() => {
            setSearch((current) => (current ? { ...current, provider } : current));
            onConfigSaved();
          })
          .catch((e: unknown) => onError(errorMessage(e)));
      }}
      onSaveKey={async (account, key) => {
        onError(undefined);
        try {
          await client.request("credentials.set", { accountId: account.id, key });
          await refresh();
          return true;
        } catch (e) {
          onError(errorMessage(e));
          return false;
        }
      }}
      onRemove={(account) => {
        if (!window.confirm(`Remove the key for ${account.label}?`)) return;
        client
          .request("credentials.remove", { accountId: account.id })
          .then(refresh)
          .catch((e: unknown) => onError(errorMessage(e)));
      }}
    />
  );
}

function GitHubSection({ client, connected, onError, onConfigSaved }: SectionProps) {
  const [status, setStatus] = useState<GitHubStatus>();
  const refresh = useCallback(
    () =>
      client
        .request("github.get", {})
        .then(setStatus)
        .catch((e: unknown) => onError(errorMessage(e))),
    [client, onError],
  );
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  return (
    <GitHubSettings
      status={status}
      disabled={!connected}
      onGenerate={async () => {
        if (status?.sshKey && !window.confirm("Replace the stored SSH key with a new one?")) return;
        onError(undefined);
        try {
          await client.request("github.generateSshKey", { comment: "pi-bot" });
          await refresh();
        } catch (e) {
          onError(errorMessage(e));
        }
      }}
      onPaste={async (privateKey) => {
        onError(undefined);
        try {
          await client.request("github.setSshKey", { privateKey });
          await refresh();
          return true;
        } catch (e) {
          onError(errorMessage(e));
          return false;
        }
      }}
      onRemove={() => {
        if (!window.confirm("Remove the stored SSH key?")) return;
        client
          .request("github.removeSshKey", {})
          .then(refresh)
          .catch((e: unknown) => onError(errorMessage(e)));
      }}
      onSaveIdentity={async (identity) => {
        onError(undefined);
        try {
          await client.request("github.setIdentity", identity);
          await refresh();
          onConfigSaved();
          return true;
        } catch (e) {
          onError(errorMessage(e));
          return false;
        }
      }}
    />
  );
}

function BotsSection({
  client,
  connected,
  onError,
  onRestored,
}: SectionProps & { onRestored: (bot: BotSummary) => void }) {
  const [deleted, setDeleted] = useState<DeletedBotSummary[]>();
  const [restoring, setRestoring] = useState<string>();
  const [live, setLive] = useState<BotSummary[]>();
  const [orchestrator, setOrchestrator] = useState<OrchestratorStatus>();
  const [savingOrchestrator, setSavingOrchestrator] = useState(false);
  const refresh = useCallback(
    () =>
      Promise.all([
        client.request("bots.listDeleted", {}),
        client.request("bots.list", {}),
        client.request("bots.orchestrator", {}),
      ])
        .then(([removed, active, status]) => {
          setDeleted(removed.bots);
          setLive(active.bots);
          setOrchestrator(status);
        })
        .catch((e: unknown) => onError(errorMessage(e))),
    [client, onError],
  );
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  async function restore(target: DeletedBotSummary) {
    onError(undefined);
    setRestoring(target.id);
    try {
      const result = await client.request("bots.restore", { botId: target.id });
      if (result.restored) onRestored(result.bot);
      await refresh();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setRestoring(undefined);
    }
  }
  async function confirmOrchestrator(botId: string) {
    onError(undefined);
    setSavingOrchestrator(true);
    try {
      setOrchestrator(await client.request("bots.setOrchestrator", { botId }));
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setSavingOrchestrator(false);
    }
  }
  return (
    <>
      <OrchestratorPanel
        bots={live}
        status={orchestrator}
        saving={savingOrchestrator}
        disabled={!connected}
        onConfirm={(botId) => void confirmOrchestrator(botId)}
      />
      <DeletedBotsList
        bots={deleted}
        restoring={restoring}
        disabled={!connected}
        onRestore={(bot) => void restore(bot)}
      />
    </>
  );
}

function ConfigSection({ client, connected, onError, onConfigSaved }: SectionProps) {
  const [config, setConfig] = useState<Requests["config.get"]["result"]>();
  const [text, setText] = useState<string>();
  const [validation, setValidation] = useState<ValidationState>();
  const refresh = useCallback(
    () =>
      client
        .request("config.get", {})
        .then((result) => {
          setConfig(result);
          setText(result.text);
          setValidation(undefined);
        })
        .catch((e: unknown) => onError(errorMessage(e))),
    [client, onError],
  );
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  return (
    <>
      {config?.effective ? (
        <LimitsForm
          key={JSON.stringify(config.effective)}
          effective={config.effective}
          disabled={!connected || !config.path}
          onSave={async (edits) => {
            onError(undefined);
            try {
              await client.request("config.update", { edits });
              onConfigSaved();
              await refresh();
              return true;
            } catch (e) {
              onError(errorMessage(e));
              return false;
            }
          }}
        />
      ) : null}
      <ConfigEditor
        path={config?.path}
        text={text}
        validation={validation}
        disabled={!connected}
        onChange={(next) => {
          setText(next);
          setValidation(undefined);
        }}
        onValidate={() => {
          client
            .request("config.validate", { text: text ?? "" })
            .then(setValidation)
            .catch((e: unknown) => onError(errorMessage(e)));
        }}
        onSave={() => {
          void (async () => {
            const result = await client.request("config.validate", { text: text ?? "" });
            setValidation(result);
            if (!result.ok) return;
            await client.request("config.save", { text: text ?? "" });
            onConfigSaved();
            await refresh();
          })().catch((e: unknown) => onError(errorMessage(e)));
        }}
      />
    </>
  );
}

/** Settings page with one tab per area. Deleted bots are listed under Bots only. */
export function Settings({
  client,
  connected,
  section,
  onRestored,
}: {
  client: PiBotClient;
  connected: boolean;
  section: SettingsSection;
  onRestored: (bot: BotSummary) => void;
}) {
  const [error, setError] = useState<string>();
  const [restartRequired, setRestartRequired] = useState(false);
  const onError = useCallback((message: string | undefined) => setError(message), []);
  const onConfigSaved = useCallback(() => setRestartRequired(true), []);
  const [restart, setRestart] = useState<RestartState>({ phase: "idle" });

  const onRestart = useCallback(() => {
    setError(undefined);
    client
      .request("server.restart", {})
      .then(({ activeWork, mode }) => {
        client.expectRestart();
        setRestart({ phase: "restarting", activeWork, mode, dropped: false });
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [client]);

  // Restarting → the socket drops → it reconnects: the server is back with the saved config.
  useEffect(() => {
    if (restart.phase !== "restarting") return;
    if (!connected && !restart.dropped) setRestart({ ...restart, dropped: true });
    if (connected && restart.dropped) {
      setRestart({ phase: "back" });
      setRestartRequired(false);
    }
  }, [connected, restart]);

  useEffect(() => {
    if (restart.phase !== "restarting") return;
    const timer = setTimeout(
      () =>
        setRestart({
          phase: "failed",
          message:
            "Pi Bot has not come back yet. Check the server log; this page keeps reconnecting.",
        }),
      RESTART_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [restart.phase]);

  useEffect(() => {
    if (restart.phase !== "back") return;
    const timer = setTimeout(() => setRestart({ phase: "idle" }), 10_000);
    return () => clearTimeout(timer);
  }, [restart.phase]);

  useEffect(() => {
    if (!connected) return;
    client
      .request("config.get", {})
      .then((result) => {
        if (result.restartRequired) setRestartRequired(true);
      })
      .catch(() => {});
  }, [client, connected]);

  const props: SectionProps = { client, connected, onError, onConfigSaved };
  return (
    <div className="settings-page">
      <h2>Settings</h2>
      <SettingsNav section={section} />
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      <RestartNotice
        show={restartRequired}
        offer={section === "config"}
        state={restart}
        disabled={!connected}
        onRestart={onRestart}
      />
      {section === "accounts" ? <AccountsSection {...props} /> : null}
      {section === "models" ? <ModelsSection {...props} /> : null}
      {section === "search" ? <SearchSection {...props} /> : null}
      {section === "github" ? <GitHubSection {...props} /> : null}
      {section === "bots" ? <BotsSection {...props} onRestored={onRestored} /> : null}
      {section === "config" ? <ConfigSection {...props} /> : null}
    </div>
  );
}

export function SettingsNav({ section }: { section: SettingsSection }) {
  return (
    <nav className="tabs settings-tabs" aria-label="Settings sections">
      {SECTIONS.map((item) => (
        <a
          key={item.id}
          href={routeHref({ settings: true, section: item.id })}
          className={item.id === section ? "active" : undefined}
          aria-current={item.id === section ? "page" : undefined}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
