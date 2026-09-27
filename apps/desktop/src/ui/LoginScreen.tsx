import { Loader2, MessageCircle, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

import { isWeb } from "../platform/env";
import type { AppController } from "../state/app";
import { Button, Field, Input } from "./primitives";

export function LoginScreen({ controller, onDone, onInvite }: { controller: AppController; onDone: () => void; onInvite?: () => void }) {
  const [server, setServer] = useState(controller.serverUrl);
  const [username, setUsername] = useState(controller.username);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const needsCode = controller.totpRequired;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await controller.login(server.trim(), username.trim(), password, needsCode ? totpCode.replace(/\s+/g, "") : undefined);
    setBusy(false);
    onDone();
  };

  return (
    <AuthShell>
      <form className="space-y-4" onSubmit={submit}>
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent text-white shadow-md">
            <MessageCircle size={24} />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">ChikuwaChat</h1>
            <p className="text-xs text-muted">チームのチャットにログイン</p>
          </div>
        </div>
        {isWeb() ? (
          <p className="text-xs text-muted">サーバ: {server}</p>
        ) : (
          <Field label="サーバ URL">
            <Input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://chat.example.com" required autoCapitalize="off" />
          </Field>
        )}
        <Field label="ユーザー名">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoCapitalize="off" />
        </Field>
        <Field label="パスワード">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {needsCode && (
          <div className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft/50 p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck size={16} className="text-accent" /> 2 要素認証</div>
            <Field label="認証アプリの 6 桁のコード (または回復コード)">
              <Input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required autoCapitalize="off" />
            </Field>
          </div>
        )}
        {controller.error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{controller.error}</p>}
        <Button type="submit" disabled={busy || (needsCode && !totpCode.trim())} className="w-full">
          {busy && <Loader2 size={16} className="animate-spin" />}
          {busy ? "ログイン中…" : needsCode ? "コードを確認してログイン" : "ログイン"}
        </Button>
        {onInvite && (
          <button type="button" onClick={onInvite} className="block w-full text-center text-xs text-muted hover:text-ink hover:underline">
            招待リンクをお持ちの方はこちら
          </button>
        )}
      </form>
    </AuthShell>
  );
}

/** Centered card on a soft gradient, shared by the login and password screens. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-[radial-gradient(ellipse_at_top_left,var(--accent-soft),transparent_60%),radial-gradient(ellipse_at_bottom_right,color-mix(in_srgb,var(--sidebar)_25%,transparent),transparent_60%)] bg-panel p-6">
      <div className="w-[380px] max-w-full rounded-2xl border border-line bg-canvas p-7 shadow-xl">{children}</div>
    </div>
  );
}
