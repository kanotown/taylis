import { useRef, useState } from "react";

import type { ReportCategory, ReportReason } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { Button, cn, Input, Modal, Textarea } from "./primitives";
import { t } from "../i18n";

/** M104 (docs/MODERATION.md §3): the reasons, in the order the phones show them (M119: 子どもの安全 first). */
export const REPORT_REASONS: ReadonlyArray<{ value: ReportReason; label: string }> = [
  { value: "child_safety", get label() { return t("report.reason.childSafety"); } },
  { value: "spam", get label() { return t("report.reason.spam"); } },
  { value: "harassment", get label() { return t("report.reason.harassment"); } },
  { value: "inappropriate", get label() { return t("report.reason.inappropriate"); } },
  { value: "other", get label() { return t("roster.other"); } },
];

/** M119 (docs/MODERATION.md §3.1): the categories of 「問題を報告・ご意見」, 子どもの安全 first, as on the phones. */
export const REPORT_CATEGORIES: ReadonlyArray<{ value: ReportCategory; label: string }> = [
  { value: "child_safety", get label() { return t("report.reason.childSafety"); } },
  { value: "harassment", get label() { return t("report.reason.harassment"); } },
  { value: "inappropriate", get label() { return t("report.reason.inappropriate"); } },
  { value: "spam", get label() { return t("report.reason.spam"); } },
  { value: "feedback", get label() { return t("report.reason.feedback"); } },
  { value: "other", get label() { return t("roster.other"); } },
];

/** The server's limit on a report's text (after trimming). */
export const REPORT_NOTE_MAX = 4000;

/**
 * M119 「問題を報告・ご意見」 (settings) and a profile's 「報告する」 (`userId`): a category and a required text, sent to the
 * workspace's administrators (POST /reports). The client_report_id stays the same until a send succeeds, so a retry
 * after a lost answer returns the first report instead of making a second. The developer's child-safety contact is shown
 * as plain text (docs/store/CHILD_SAFETY.md).
 */
export function ProblemReportDialog({ controller, userId = null, onClose }: { controller: AppController; userId?: string | null; onClose: () => void }) {
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const clientReportId = useRef<string>(crypto.randomUUID());
  const name = userId ? controller.store.users.get(userId)?.display_name ?? t("common.unknownUser") : null;
  const trimmed = note.trim().length;
  const ready = !!category && trimmed > 0 && trimmed <= REPORT_NOTE_MAX;
  const send = async () => {
    if (!category || !ready || busy) return;
    setBusy(true);
    const ok = await controller.submitReport({ category, note, userId, clientReportId: clientReportId.current });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      onClose={onClose}
      title={name ? t("problemReport.userTitle", { name }) : t("problemReport.title")}
      description={userId ? t("problemReport.userDescription") : t("problemReport.description")}
      className="w-[480px]"
    >
      <div className="mt-4 space-y-3">
        <div role="radiogroup" aria-label={t("problemReport.category")} className="grid grid-cols-2 gap-1.5">
          {REPORT_CATEGORIES.map((item) => (
            <label key={item.value} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm", category === item.value && "border-accent bg-accent-soft/60")}>
              <input type="radio" name="problem-report-category" value={item.value} checked={category === item.value} onChange={() => setCategory(item.value)} />
              {item.label}
            </label>
          ))}
        </div>
        <div>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("problemReport.notePlaceholder")}
            rows={5}
            maxLength={REPORT_NOTE_MAX}
            aria-label={t("problemReport.note")}
            aria-required
          />
          <div className={cn("mt-1 text-right text-xs tabular-nums", note.length >= REPORT_NOTE_MAX ? "text-danger" : "text-muted")} data-testid="report-note-count">
            {t("problemReport.count", { count: note.length, max: REPORT_NOTE_MAX })}
          </div>
        </div>
        <p className="select-text text-xs text-muted" data-testid="child-safety-contact">
          {t("problemReport.contactLabel")}{t("problemReport.contact")}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={busy || !ready} onClick={() => void send()}>{t("problemReport.send")}</Button>
        </div>
      </div>
    </Modal>
  );
}

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
