import { useState } from "react";

import type { ReportReason } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { Button, cn, Input, Modal, Textarea } from "./primitives";
import { t } from "../i18n";

/** M104 (docs/MODERATION.md §3): the reasons, in the order the phones show them. */
export const REPORT_REASONS: ReadonlyArray<{ value: ReportReason; label: string }> = [
  { value: "spam", get label() { return t("report.reason.spam"); } },
  { value: "harassment", get label() { return t("report.reason.harassment"); } },
  { value: "inappropriate", get label() { return t("report.reason.inappropriate"); } },
  { value: "other", get label() { return t("roster.other"); } },
];

/** 「報告する」: a reason and an optional note; the administrators are told, the author is not. */
export function ReportDialog({ controller, message, onClose }: { controller: AppController; message: MessageState; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!reason) return;
    setBusy(true);
    const ok = await controller.reportMessage(message.id, reason, note);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title={t("report.title")} description={t("report.description")} className="w-[440px]">
      <div className="mt-4 space-y-3">
        <div role="radiogroup" aria-label={t("report.reason")} className="space-y-1.5">
          {REPORT_REASONS.map((item) => (
            <label key={item.value} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm", reason === item.value && "border-accent bg-accent-soft/60")}>
              <input type="radio" name="report-reason" value={item.value} checked={reason === item.value} onChange={() => setReason(item.value)} />
              {item.label}
            </label>
          ))}
        </div>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("report.notePlaceholder")} rows={2} maxLength={1000} aria-label={t("report.note")} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={busy || !reason} onClick={() => void send()}>{t("report.send")}</Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 「アカウントを削除」 (docs/MODERATION.md §2): confirmed with the password, or the username for an account without one
 * (Google sign-in). Immediate and final; messages stay under 「退会したユーザー」.
 */
export function DeleteAccountDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const me = controller.store.me;
  const hasPassword = me?.has_password !== false;
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(null);
    const failure = await controller.deleteAccount(secret);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  return (
    <Modal onClose={onClose} title={t("settings.account.delete")} description={t("deleteAccount.cannotUndo")} className="w-[460px]">
      <div className="mt-4 space-y-3 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>{t("deleteAccount.point1")}</li>
          <li>{t("deleteAccount.point2")}</li>
          <li>{t("deleteAccount.point3")}</li>
        </ul>
        <label className="block">
          <span className="text-xs text-muted">{hasPassword ? t("deleteAccount.enterPassword") : t("deleteAccount.enterUsername", { username: me?.username ?? "" })}</span>
          <Input
            type={hasPassword ? "password" : "text"}
            autoComplete={hasPassword ? "current-password" : "off"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="mt-1"
            autoFocus
          />
        </label>
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="danger" size="sm" disabled={busy || !secret.trim()} onClick={() => void remove()}>{t("settings.account.delete")}</Button>
        </div>
      </div>
    </Modal>
  );
}
