import { Fragment, useEffect, useState, useSyncExternalStore } from "react";

import { getLocale, setLocalePreference, subscribeLocale } from "../i18n";
import type { AppController } from "../state/app";
import { ChangePasswordScreen } from "./ChangePasswordScreen";
import { useAppVersion } from "./hooks";
import { inviteLink } from "./invite";
import { InviteScreen } from "./InviteScreen";
import { LoginScreen } from "./LoginScreen";
import { MainScreen } from "./MainScreen";
import { UpdateBanner } from "./UpdateBanner";
import { ScreenTitleStrip } from "./WindowControls";
import { RAIL_WIDTH, WorkspaceRail } from "./WorkspaceRail";
import { t } from "../i18n";

export function App({ controller }: { controller: AppController }) {
  useAppVersion(controller);
  // The store instance is replaced on login; force a resubscribe by keying on it.
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  // M12h: 「招待リンクで参加」 replaces the login form until the account exists or the user goes back.
  const [invite, setInvite] = useState(false);
  // M115 (docs/I18N.md): the UI language. My choice comes with UserMe (also from my other devices, user.updated);
  // undefined = a server older than the field (keep what this device had). A change redraws everything below.
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const chosen = controller.screen === "main" ? controller.store.me?.locale : undefined;
  useEffect(() => {
    if (chosen !== undefined) setLocalePreference(chosen);
  }, [chosen]);

  const screen = (() => {
    switch (controller.screen) {
      case "boot":
        return <div className="flex h-full items-center justify-center text-sm text-muted">{t("app.starting")}</div>;
      case "login":
        if (invite || controller.entryInvite) {
          const initialLink = controller.entryInvite ? inviteLink(controller.serverUrl, controller.entryInvite) : undefined;
          const leave = () => { controller.entryInvite = null; setInvite(false); };
          return <InviteScreen controller={controller} initialLink={initialLink} onBack={leave} onDone={() => { leave(); bump(); }} />;
        }
        // Keyed by workspace: the form starts from that workspace's server and user (M16c).
        return <LoginScreen key={`${controller.activeServer}|${controller.addingWorkspace}`} controller={controller} onDone={bump} onInvite={() => setInvite(true)} />;
      case "change_password":
        return <ChangePasswordScreen controller={controller} onDone={bump} />;
      case "main":
        // A workspace switch mounts its own screen (open conversation, panes) from its engine.
        return <MainScreen key={`${controller.activeServer}|${controller.store.version === 0 ? "fresh" : "loaded"}`} controller={controller} />;
    }
  })();

  // macOS (overlay) and Windows (no system title bar): screens without the top bar get a strip to drag the window by,
  // with the window buttons on Windows. The main screen's top row is the title bar there.
  const dragStrip = controller.screen !== "main" ? <ScreenTitleStrip leftInset={controller.showsRail ? RAIL_WIDTH : 0} /> : null;

  // M16c: with two or more workspaces the rail runs down the left edge (WORKSPACES.md §5).
  if (!controller.showsRail) {
    return (
      <Fragment key={locale}>
        {dragStrip}
        {screen}
        <UpdateBanner controller={controller} />
      </Fragment>
    );
  }
  return (
    <div key={locale} className="flex h-full min-h-0">
      {dragStrip}
      <WorkspaceRail controller={controller} />
      <div className="min-w-0 flex-1">{screen}</div>
      <UpdateBanner controller={controller} />
    </div>
  );
}
