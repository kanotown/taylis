import { useEffect, useState } from "react";

import type { AppController } from "../state/app";
import { t } from "../i18n";

/** "Alice が入力中…" under the timeline; volatile (SYNC_PROTOCOL.md §5.2), re-checked every second so entries expire. */
export function TypingIndicator({ controller, channelId, parentId = null }: { controller: AppController; channelId: string; parentId?: string | null }) {
  const store = controller.store;
  const [now, setNow] = useState(() => Date.now());
  const users = store.typingUsers(channelId, parentId, now);
  useEffect(() => {
    if (users.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [users.length]);
  if (users.length === 0) return <div className="h-5" aria-hidden="true" />;
  const names = users.map((id) => store.users.get(id)?.display_name ?? "…");
  const label = names.length <= 2 ? t("typing.names", { names: names.join(t("common.listSeparator")) }) : t("typing.many", { name: names[0], count: names.length - 1 });
  return (
    <div className="flex h-5 items-center gap-1.5 px-4 text-xs text-muted" aria-live="polite">
      <span className="flex gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1 w-1 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}
