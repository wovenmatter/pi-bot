import { Check } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, type PiBotClient } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
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

  const steps = [
    { label: "Sign in", done: status.signedIn },
    { label: "Choose a model", done: status.signedIn && status.mainModelAvailable },
  ];
  const current = steps.findIndex((step) => !step.done);

  return (
    <div className="onboarding">
      <header className="onboarding-hero">
        <span className="brand-mark onboarding-mark" aria-hidden="true">
          π
        </span>
        <h1>Welcome to Pi Bot</h1>
        <p className="muted">Connect a model provider. Admin Bot takes it from there.</p>
      </header>
      <ol className="onboarding-steps" aria-label="Setup steps">
        {steps.map((step, index) => (
          <li
            key={step.label}
            className={step.done ? "done" : index === current ? "current" : undefined}
            aria-current={index === current ? "step" : undefined}
          >
            <span className="onboarding-step-marker" aria-hidden="true">
              {step.done ? <Icon icon={Check} size={12} weight="send" /> : index + 1}
            </span>
            {step.label}
          </li>
        ))}
      </ol>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      <section className="onboarding-card">
        {status.signedIn ? (
          <>
            <h2>Choose Admin Bot's model</h2>
            <p className="muted">You can set up more models with Admin Bot later.</p>
            <MainModelPicker
              providers={providers}
              current={status.mainModel}
              disabled={!connected}
              submitLabel="Start chatting"
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
          </>
        ) : (
          <>
            <h2>Sign in to a provider</h2>
            <p className="muted">One is enough to start. Add more any time in Settings.</p>
            <AccountsSection
              client={client}
              connected={connected}
              intro={false}
              onError={setError}
              onChanged={() => void refresh()}
            />
          </>
        )}
      </section>
    </div>
  );
}
