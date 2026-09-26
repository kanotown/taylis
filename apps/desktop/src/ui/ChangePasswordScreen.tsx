import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { AuthShell } from "./LoginScreen";
import { Button, Field, Input } from "./primitives";

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
          <h1 className="text-xl font-bold tracking-tight">パスワードの変更</h1>
          <p className="mt-1 text-sm text-muted">仮パスワードでログインしています。続ける前に新しいパスワードを設定してください。</p>
        </div>
        <Field label="現在のパスワード">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="新しいパスワード (8 文字以上)">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} autoComplete="new-password" required />
        </Field>
        <Field label="新しいパスワード (確認)">
          <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </Field>
        {mismatch && repeat && <p className="text-sm text-danger">パスワードが一致しません</p>}
        {controller.error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{controller.error}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || mismatch} className="flex-1">
            変更する
          </Button>
          <Button type="button" variant="secondary" onClick={() => void controller.logout()}>
            ログアウト
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
