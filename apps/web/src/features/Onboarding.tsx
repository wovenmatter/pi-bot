import { useCallback, useEffect, useState } from "react";
import { errorMessage, type PiBotClient } from "../api.ts";
import { ErrorNotice } from "../components/ui.tsx";
import type { OnboardingStatus, ProviderModels } from "../protocol.ts";
import { AccountsSection } from "./Settings.tsx";
import { MainModelPicker } from "./settings/Profiles.tsx";

/**
 * First run: 1. sign in to a provider, 2. (only if its model is not available) pick the main model
 * of Admin Bot's profile. Then chat with Admin Bot, which sets up model profiles with you.
 */
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
        Sign in, then you chat with <strong>Admin Bot</strong>: your account and config bot. It will
        explain the platform, ask about your plans and budget, and set up model profiles, bots and
        teams with you.
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
      {status.signedIn && status.mainModelAvailable ? null : (
        <>
          <h3>2. Pick Admin Bot's main model</h3>
          {status.signedIn ? (
            <MainModelPicker
              providers={providers}
              current={status.mainModel}
              disabled={!connected}
              submitLabel="Start"
              onSave={async (model) => {
                setError(undefined);
                try {
                  await client.request("onboarding.setMainModel", { model });
                  await refresh();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          ) : (
            <p className="muted">Sign in first.</p>
          )}
        </>
      )}
    </div>
  );
}
