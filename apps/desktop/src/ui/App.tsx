import { useState } from "react";

import type { AppController } from "../state/app";
import { ChangePasswordScreen } from "./ChangePasswordScreen";
import { useAppVersion } from "./hooks";
import { inviteLink } from "./invite";
import { InviteScreen } from "./InviteScreen";
import { LoginScreen } from "./LoginScreen";
import { MainScreen } from "./MainScreen";
import { UpdateBanner } from "./UpdateBanner";
import { WorkspaceRail } from "./WorkspaceRail";
import { overlayTitleBar } from "../platform/env";

export function App({ controller }: { controller: AppController }) {
  useAppVersion(controller);
  // The store instance is replaced on login; force a resubscribe by keying on it.
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  // M12h: 「招待リンクで参加」 replaces the login form until the account exists or the user goes back.
  const [invite, setInvite] = useState(false);

  const screen = (() => {
    switch (controller.screen) {
      case "boot":
        return <div className="flex h-full items-center justify-center text-sm text-muted">起動中…</div>;
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

  // macOS: the window has no title bar of its own (overlay); screens without the top bar get a strip to drag it by.
  const dragStrip = overlayTitleBar() && controller.screen !== "main" ? <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-8" /> : null;

  // M16c: with two or more workspaces the rail runs down the left edge (WORKSPACES.md §5).
  if (!controller.showsRail) {
    return (
      <>
        {dragStrip}
        {screen}
        <UpdateBanner controller={controller} />
      </>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      {dragStrip}
      <WorkspaceRail controller={controller} />
      <div className="min-w-0 flex-1">{screen}</div>
      <UpdateBanner controller={controller} />
    </div>
  );
}
