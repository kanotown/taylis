import { isTauri } from "./env";

/** Refresh tokens: Keychain / Credential Manager through the Rust commands (SECURITY.md §2.3). */
export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

class TauriSecretStore implements SecretStore {
  private async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  get(account: string): Promise<string | null> {
    return this.invoke<string | null>("secret_get", { account });
  }

  set(account: string, value: string): Promise<void> {
    return this.invoke<void>("secret_set", { account, value });
  }

  delete(account: string): Promise<void> {
    return this.invoke<void>("secret_delete", { account });
  }
}

/** Browser dev fallback only (`npm run dev` outside Tauri): never used in the packaged app. */
class LocalStorageSecretStore implements SecretStore {
  async get(account: string): Promise<string | null> {
    return localStorage.getItem("secret:" + account);
  }

  async set(account: string, value: string): Promise<void> {
    localStorage.setItem("secret:" + account, value);
  }

  async delete(account: string): Promise<void> {
    localStorage.removeItem("secret:" + account);
  }
}

export function secretStore(): SecretStore {
  return isTauri() ? new TauriSecretStore() : new LocalStorageSecretStore();
}
