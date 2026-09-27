import { useState } from "react";

import type { AppController } from "../state/app";
import { ChangePasswordScreen } from "./ChangePasswordScreen";
import { useAppVersion } from "./hooks";
import { InviteScreen } from "./InviteScreen";
import { LoginScreen } from "./LoginScreen";
import { MainScreen } from "./MainScreen";

export function App({ controller }: { controller: AppController }) {
  useAppVersion(controller);
  // The store instance is replaced on login; force a resubscribe by keying on it.
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  // M12h: 「招待リンクで参加」 replaces the login form until the account exists or the user goes back.
  const [invite, setInvite] = useState(false);

  switch (controller.screen) {
    case "boot":
      return <div className="flex h-full items-center justify-center text-sm text-muted">起動中…</div>;
    case "login":
      return invite ? <InviteScreen controller={controller} onBack={() => setInvite(false)} onDone={() => { setInvite(false); bump(); }} /> : <LoginScreen controller={controller} onDone={bump} onInvite={() => setInvite(true)} />;
    case "change_password":
      return <ChangePasswordScreen controller={controller} onDone={bump} />;
    case "main":
      return <MainScreen key={controller.store.version === 0 ? "fresh" : "loaded"} controller={controller} />;
  }
}
