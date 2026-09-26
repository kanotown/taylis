import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useEffect } from "react";

import type { AppController } from "../state/app";

/** Transient error banner for actions that fail after login (edit, upload, settings…). */
export function Toast({ controller }: { controller: AppController }) {
  const message = controller.error;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => controller.setError(null), 6000);
    return () => clearTimeout(timer);
  }, [message, controller]);
  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-6 left-1/2 z-50 flex max-w-[80vw] -translate-x-1/2 items-center gap-3 rounded-xl border border-danger/40 bg-canvas px-4 py-3 text-sm text-ink shadow-2xl"
    >
      <AlertCircle size={18} className="shrink-0 text-danger" />
      <span>{message}</span>
      <button type="button" className="rounded-md p-1 text-muted hover:bg-ink/6 hover:text-ink" onClick={() => controller.setError(null)} aria-label="閉じる">
        <X size={14} />
      </button>
    </div>
  );
}

/** Short confirmation (M12b 「リンクをコピーしました」); disappears by itself. */
export function NoticeToast({ controller }: { controller: AppController }) {
  const message = controller.notice;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => controller.setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [message, controller]);
  if (!message) return null;
  return (
    <div role="status" className="fixed bottom-6 left-1/2 z-50 flex max-w-[80vw] -translate-x-1/2 items-center gap-2 rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink shadow-2xl">
      <CheckCircle2 size={16} className="shrink-0 text-success" />
      <span>{message}</span>
    </div>
  );
}
