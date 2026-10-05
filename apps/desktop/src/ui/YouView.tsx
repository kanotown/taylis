import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isWeb } from "../platform/env";
import type { AppController } from "../state/app";
import { useStoreUpdates } from "./hooks";
import { IconButton } from "./primitives";
import { LogoutConfirm, SECTION_TITLES, SettingsList, SettingsSectionBody, type SettingsSection } from "./Settings";
import { t } from "../i18n";

/** The history field that holds the pushed screen (the browser's Back returns to the list). */
const FIELD = "chikuwaYou";

/**
 * The phone's 「自分」 tab (M34; M40 = MOBILE_UI.md §6.5): one list — me, 「ステータスを更新」, 「通知を一時停止」,
 * 「おやすみ時間」, then the screens (通知, 表示, 入力, プロフィールを編集, アカウント, ワークスペース, 管理) and a red
 * 「ログアウト」. A row pushes its screen; ← or the browser's Back returns to the list.
 */
export function YouView({ controller, popToRoot = 0 }: { controller: AppController; /** Bumped by a tap on 「自分」 while it is selected. */ popToRoot?: number }) {
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  useStoreUpdates(controller);
  const seenPop = useRef(popToRoot);
  useEffect(() => {
    if (seenPop.current === popToRoot) return;
    seenPop.current = popToRoot;
    setSection(null);
    if (isWeb() && history.state?.[FIELD]) history.back();
  }, [popToRoot]);
  // In a browser a pushed screen is a history entry of its own: Back (the gesture, the button) returns to the list.
  useEffect(() => {
    if (!isWeb()) return;
    const pop = (event: PopStateEvent) => setSection((event.state?.[FIELD] as SettingsSection | undefined) ?? null);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const open = (next: SettingsSection) => {
    if (isWeb()) {
      // The list's own entry must not name a screen (an entry the tabs pushed from a screen copies the field).
      const { [FIELD]: _, ...rest } = (history.state ?? {}) as Record<string, unknown>;
      history.replaceState(rest, "");
      history.pushState({ ...rest, [FIELD]: next }, "");
    }
    setSection(next);
  };
  const back = () => {
    setSection(null);
    if (isWeb() && history.state?.[FIELD]) history.back();
  };

  if (section) {
    const admin = section === "admin";
    return (
      <section aria-label={SECTION_TITLES[section]} data-you-section={section} className="flex min-h-0 flex-1 flex-col bg-canvas">
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
          <IconButton label={t("common.back")} className="-ml-2 shrink-0" onClick={back}>
            <ArrowLeft size={20} />
          </IconButton>
          <strong className="min-w-0 flex-1 truncate text-[17px]">{SECTION_TITLES[section]}</strong>
        </header>
        <div className={admin ? "flex min-h-0 flex-1 flex-col px-2 pt-1" : "min-h-0 flex-1 overflow-y-auto px-4 py-4"}>
          <SettingsSectionBody controller={controller} section={section} onDone={back} />
        </div>
      </section>
    );
  }
  return (
    <section aria-label={t("mobileTabs.you")} className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center border-b border-line px-4">
        <strong className="min-w-0 flex-1 truncate text-[17px]">{t("mobileTabs.you")}</strong>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-panel/50">
        <SettingsList controller={controller} variant="page" onSelect={open} onLogout={() => setConfirmLogout(true)} />
      </div>
      {confirmLogout && <LogoutConfirm controller={controller} onClose={() => setConfirmLogout(false)} />}
    </section>
  );
}
