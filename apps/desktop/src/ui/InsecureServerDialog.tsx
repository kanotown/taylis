import { type ReactNode, useState } from "react";

import { t } from "../i18n";
import { isWeb } from "../platform/env";
import { classifyServerUrl, httpsVariant } from "../state/serverUrlSecurity";
import { normalizeServerUrl } from "../state/workspaces";
import { Button, Modal } from "./primitives";

interface Pending {
  url: string;
  typed: string;
  proceed: (server: string) => void;
}

/**
 * M190 (SECURITY.md §6.1): 「暗号化されていない接続です」 before a sign-in form (or an invite link) first contacts a server
 * over plain HTTP across the internet. `check(server, proceed)` goes on at once for https and for a LAN / this computer;
 * otherwise `proceed` waits for 「https で接続」 (the same URL with https) or 「このまま接続」 (as typed). Nothing is
 * remembered. The Web build always talks to its own origin and is never asked.
 */
export function useInsecureServerCheck(): { check: (server: string, proceed: (server: string) => void) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const check = (server: string, proceed: (server: string) => void) => {
    const url = isWeb() ? null : normalizeServerUrl(server);
    // Not a URL: the form goes on and says so.
    if (url === null || classifyServerUrl(url) !== "insecure") {
      proceed(server);
      return;
    }
    setPending({ url, typed: server, proceed });
  };
  const choose = (server: string | null) => {
    const current = pending;
    setPending(null);
    if (current && server !== null) current.proceed(server);
  };
  const dialog = pending && (
    <Modal onClose={() => choose(null)} title={t("insecureServer.title")} description={t("insecureServer.body")} className="w-[460px]">
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => choose(null)}>{t("common.cancel")}</Button>
        <Button variant="danger" onClick={() => choose(pending.typed)}>{t("insecureServer.continue")}</Button>
        <Button autoFocus onClick={() => choose(httpsVariant(pending.url))}>{t("insecureServer.useHttps")}</Button>
      </div>
    </Modal>
  );
  return { check, dialog };
}
