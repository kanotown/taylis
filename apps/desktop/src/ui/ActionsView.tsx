/** 操作ボタン (M143, docs/ACTIONS.md §9.1): the 「操作」 page, the buttons I may press in their groups. */
import { Zap } from "lucide-react";
import { useEffect } from "react";

import type { AppController } from "../state/app";
import { pressable } from "./actions";
import { ActionButtons, useActionStatuses } from "./ActionButtons";
import { BackButton } from "./compact";
import { useStoreUpdates } from "./hooks";
import { t } from "../i18n";

export function ActionsView({ controller }: { controller: AppController }) {
  useStoreUpdates(controller);
  useEffect(() => {
    void controller.engine?.loadActions();
  }, [controller]);
  const actions = pressable(controller.store.actions);
  const feed = useActionStatuses(controller, actions);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-actions-page>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:px-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><Zap size={18} /></span>
        <strong className="text-[15px]">{t("nav.actions")}</strong>
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
        <div className="mx-auto max-w-4xl space-y-4">
          {actions.length ? <ActionButtons controller={controller} actions={actions} feed={feed} /> : <p className="text-sm text-muted">{t("actions.page.none")}</p>}
        </div>
      </div>
    </div>
  );
}
