import { COOKIE_SESSION } from "../api/client";
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

/**
 * Browser (M12j): the refresh token is an HttpOnly cookie the page cannot read, so nothing secret
 * is stored here; we only remember that a session was opened, to try the cookie at startup.
 */
class CookieSessionStore implements SecretStore {
  async get(account: string): Promise<string | null> {
    return localStorage.getItem("session:" + account) ? COOKIE_SESSION : null;
  }

  async set(account: string): Promise<void> {
    localStorage.setItem("session:" + account, "1");
  }

  async delete(account: string): Promise<void> {
    localStorage.removeItem("session:" + account);
  }
}

export function secretStore(): SecretStore {
  return isTauri() ? new TauriSecretStore() : new CookieSessionStore();
}
