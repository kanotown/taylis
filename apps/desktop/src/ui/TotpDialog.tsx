import { Copy, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { TotpSetupOut } from "../api/types";
import type { AppController } from "../state/app";
import { Button, Field, Input, Modal } from "./primitives";
import { normalizeTotpInput, recoveryCodesText } from "./totp";
import { t } from "../i18n";

/** Turning 2FA on (M12i): password → scan the QR and confirm a code → keep the recovery codes. */
export function TotpSetupDialog({ controller, onClose, onEnabled }: { controller: AppController; onClose: () => void; onEnabled: () => void }) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TotpSetupOut | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await controller.beginTotpSetup(password);
    setBusy(false);
    if ("error" in result) setError(result.error);
    else setSetup(result);
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await controller.enableTotp(normalizeTotpInput(code));
    setBusy(false);
    if ("error" in result) setError(result.error);
    else setRecovery(result.recovery_codes);
  };

  const copyCodes = async () => {
    if (!recovery) return;
    setCopied(await controller.copyToClipboard(recoveryCodesText(recovery), t("totp.codesCopied")));
  };

  return (
    <Modal onClose={recovery ? onEnabled : onClose} title={t("totp.enableTitle")} className="w-[460px]" hideClose={!!recovery}>
      {recovery ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
            <ShieldCheck size={18} /> {t("totp.enabled")}
          </div>
          <p className="text-sm text-muted">{t("totp.saveCodes")}</p>
          <ul className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-panel p-3 font-mono text-sm">
            {recovery.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => void copyCodes()}>
              <Copy size={14} /> {copied ? t("calendarFeeds.copied") : t("totp.copyCodes")}
            </Button>
            <Button size="sm" onClick={onEnabled}>{t("totp.savedClose")}</Button>
          </div>
        </div>
      ) : setup ? (
        <form className="mt-4 space-y-3" onSubmit={confirm}>
          <p className="text-sm text-muted">{t("totp.scan")}</p>
          <div className="flex items-start gap-4">
            <img src={`data:image/png;base64,${setup.qr_png_base64}`} alt={t("totp.qrAlt")} width={168} height={168} className="shrink-0 rounded-lg border border-line bg-white" />
            <div className="min-w-0 space-y-2 text-sm">
              <div className="text-xs text-muted">{t("totp.manualKey")}</div>
              <code className="block break-all rounded bg-panel px-2 py-1 font-mono text-xs">{setup.secret}</code>
              <div className="text-xs text-muted">{t("totp.kind")}</div>
            </div>
          </div>
          <Field label={t("totp.codeLabel")}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
          </Field>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" size="sm" disabled={busy || normalizeTotpInput(code).length !== 6}>{t("totp.verifyEnable")}</Button>
          </div>
        </form>
      ) : (
        <form className="mt-4 space-y-3" onSubmit={begin}>
          <p className="text-sm text-muted">{t("totp.intro")}</p>
          <Field label={t("settings.account.currentPassword")}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
          </Field>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" size="sm" disabled={busy || !password}>{t("totp.next")}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Turning 2FA off needs the password again. */
export function TotpDisableDialog({ controller, onClose, onDisabled }: { controller: AppController; onClose: () => void; onDisabled: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const failure = await controller.disableTotp(password);
    setBusy(false);
    if (failure) setError(failure);
    else onDisabled();
  };

  return (
    <Modal onClose={onClose} title={t("totp.disableTitle")} className="w-[420px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <p className="text-sm text-muted">{t("totp.disableNote")}</p>
        <Field label={t("settings.account.currentPassword")}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
        </Field>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="danger" size="sm" disabled={busy || !password}>{t("settings.account.turnOff")}</Button>
        </div>
      </form>
    </Modal>
  );
}
