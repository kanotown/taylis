import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { AuthShell } from "./LoginScreen";
import { Button, Field, Input } from "./primitives";
import { t } from "../i18n";

export function ChangePasswordScreen({ controller, onDone }: { controller: AppController; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = next !== repeat;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    await controller.changePassword(current, next);
    setBusy(false);
    onDone();
  };

  return (
    <AuthShell>
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <h1 className="text-xl font-bold tracking-tight">{t("settings.account.changePassword")}</h1>
          <p className="mt-1 text-sm text-muted">{t("changePassword.note")}</p>
        </div>
        <Field label={t("settings.account.currentPassword")}>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label={t("settings.account.newPassword")}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} autoComplete="new-password" required />
        </Field>
        <Field label={t("settings.account.repeatPassword")}>
          <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </Field>
        {mismatch && repeat && <p className="text-sm text-danger">{t("inviteScreen.mismatch")}</p>}
        {controller.error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{controller.error}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || mismatch} className="flex-1">
            {t("settings.account.change")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void controller.logout()}>
            {t("common.logout")}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
