import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class KeychainUnavailableError extends Error {
  override name = "KeychainUnavailableError";
}

/**
 * macOS Keychain credential store (service `io.wovenmatter.pi-bot`, one generic password per
 * provider id). Stub in milestone 1: every operation throws, and `backend = "auto"` falls back
 * to the encrypted SQLite store until it is implemented.
 */
export class KeychainCredentialStore implements CredentialStore {
  static readonly service = "io.wovenmatter.pi-bot";
  static readonly implemented = false;

  #unavailable(): never {
    throw new KeychainUnavailableError(
      "the macOS Keychain credential store is not implemented yet",
    );
  }

  async read(_providerId: string): Promise<Credential | undefined> {
    this.#unavailable();
  }

  async list(): Promise<readonly CredentialInfo[]> {
    this.#unavailable();
  }

  async modify(
    _providerId: string,
    _fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    this.#unavailable();
  }

  async delete(_providerId: string): Promise<void> {
    this.#unavailable();
  }
}
