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
    <div className="toast" role="alert">
      <span>{message}</span>
      <button className="link" onClick={() => controller.setError(null)} aria-label="閉じる">
        ✕
      </button>
    </div>
  );
}
