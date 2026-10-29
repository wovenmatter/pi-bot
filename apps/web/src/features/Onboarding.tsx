import { useCallback, useEffect, useState } from "react";
import { errorMessage, type PiBotClient } from "../api.ts";
import { ErrorNotice } from "../components/ui.tsx";
import type { OnboardingStatus, ProviderModels } from "../protocol.ts";
import { AccountsSection } from "./Settings.tsx";
import { AdminModelPicker } from "./settings/Teams.tsx";

/** First run: 1. sign in to a provider, 2. pick Admin Bot's model. Then chat with Admin Bot. */
export function Onboarding({
  client,
  connected,
  status,
  onStatus,
}: {
  client: PiBotClient;
  connected: boolean;
  status: OnboardingStatus;
  onStatus: (status: OnboardingStatus) => void;
}) {
  const [error, setError] = useState<string>();
  const [providers, setProviders] = useState<ProviderModels[]>();
  const refresh = useCallback(
    () =>
      client
        .request("onboarding.status", {})
        .then(onStatus)
        .catch((e: unknown) => setError(errorMessage(e))),
    [client, onStatus],
  );
  useEffect(() => {
    if (!connected || !status.signedIn) return;
    client
      .request("models.catalog", {})
      .then((catalog) => setProviders(catalog.providers))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [client, connected, status.signedIn]);

  return (
    <div className="onboarding">
      <h2>Welcome to Pi Bot</h2>
      <p className="muted">
        Two quick steps, then you chat with <strong>Admin Bot</strong>: your account and config bot.
        It will explain the platform and set up the bots and teams you want.
      </p>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      <h3>1. Sign in {status.signedIn ? "✓" : null}</h3>
      {status.signedIn ? (
        <p className="muted">Signed in. You can add more accounts later in Settings.</p>
      ) : (
        <AccountsSection
          client={client}
          connected={connected}
          onError={setError}
          onChanged={() => void refresh()}
        />
      )}
      <h3>2. Pick Admin Bot's model</h3>
      {status.signedIn ? (
        <AdminModelPicker
          providers={providers}
          {...(status.adminModel ? { current: status.adminModel } : {})}
          disabled={!connected}
          submitLabel="Start"
          onSave={async (model) => {
            setError(undefined);
            try {
              await client.request("admin.setModel", { model });
              await refresh();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        />
      ) : (
        <p className="muted">Sign in first.</p>
      )}
    </div>
  );
}
