import { Loader2, MessageCircle, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { ApiClient } from "../api/client";
import { isWeb } from "../platform/env";
import type { AppController } from "../state/app";
import { isServerInfo, normalizeServerUrl } from "../state/workspaces";
import { Button, Field, Input } from "./primitives";
import { WorkspaceIcon } from "./workspaceIcons";

export function LoginScreen({ controller, onDone, onInvite }: { controller: AppController; onDone: () => void; onInvite?: () => void }) {
  const [server, setServer] = useState(controller.serverUrl);
  const [username, setUsername] = useState(controller.username);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const needsCode = controller.totpRequired;
  // M16c: adding another workspace (cancel returns), or signing back in to a registered one.
  const adding = controller.addingWorkspace;
  const entry = adding ? null : controller.activeEntry;
  // M48: 「Google でログイン」 when the server offers it (docs/SSO.md §6). The browser's server is the page's own
  // origin, asked once; the Tauri app asks again as the server URL is typed (and gets the ticket by a deep link).
  const [google, setGoogle] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const methodsKey = isWeb() ? "" : server.trim();
  useEffect(() => {
    let current = true;
    setGoogle(false);
    const timer = setTimeout(() => {
      void controller.authMethods(methodsKey).then((methods) => {
        if (current) setGoogle(methods?.google.enabled === true);
      });
    }, isWeb() || methodsKey === controller.serverUrl.trim() ? 0 : 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [controller, methodsKey]);

  // M93: the workspace's icon (public, GET /server) in place of the app's mark, before signing in. A registered
  // workspace shows the one it knows at once; the server is asked again (as the URL is typed, in the desktop app).
  const [icon, setIcon] = useState<{ server: string; version: string } | null>(() => (entry?.iconVersion ? { server: entry.serverUrl, version: entry.iconVersion } : null));
  const iconKey = isWeb() ? controller.serverUrl : server.trim();
  useEffect(() => {
    const target = normalizeServerUrl(iconKey);
    if (!target) {
      setIcon(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      new ApiClient(target)
        .serverInfo()
        .then((info: unknown) => {
          if (!current || !isServerInfo(info) || info.icon_version === undefined) return;
          setIcon(info.icon_version ? { server: target, version: info.icon_version } : null);
        })
        .catch(() => {
          /* not a server (yet): keep the app's mark */
        });
    }, entry && iconKey === entry.serverUrl ? 0 : 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [iconKey, entry]);

  const signInWithGoogle = async () => {
    setLeaving(true);
    await controller.startGoogleSignIn(server);
    setLeaving(false); // still here: the start failed and the form shows why
  };

  if (controller.ssoState !== "idle") return <SsoWaiting controller={controller} />;

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
          {icon ? (
            <WorkspaceIcon serverUrl={icon.server} version={icon.version} name={entry?.name ?? ""} colorKey={entry?.workspaceId ?? icon.server} className="h-11 w-11 rounded-2xl text-lg shadow-md" />
          ) : (
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent text-white shadow-md">
              <MessageCircle size={24} />
            </span>
          )}
          <div>
            <h1 className="text-xl font-bold tracking-tight">{adding ? "ワークスペースを追加" : entry ? entry.name : "Taylis"}</h1>
            <p className="text-xs text-muted">{adding ? "別の Taylis サーバにログインします" : entry?.signedOut ? "もう一度ログインしてください" : "チームのチャットにログイン"}</p>
          </div>
        </div>
        {isWeb() ? (
          <p className="text-xs text-muted">サーバ: {server}</p>
        ) : (
          <Field label="サーバ URL">
            <Input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://chat.example.com" required autoCapitalize="off" autoFocus={adding} />
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
        {google && !(adding && isWeb()) && (
          <>
            <div className="flex items-center gap-3 text-xs text-muted" role="separator">
              <span className="h-px flex-1 bg-line" />
              または
              <span className="h-px flex-1 bg-line" />
            </div>
            <Button type="button" variant="secondary" className="w-full" disabled={leaving || busy} onClick={() => void signInWithGoogle()}>
              {leaving ? <Loader2 size={16} className="animate-spin" /> : <GoogleMark />}
              Google でログイン
            </Button>
          </>
        )}
        {adding && (
          <Button type="button" variant="secondary" className="w-full" onClick={() => controller.cancelAddWorkspace()}>
            キャンセル
          </Button>
        )}
        {!adding && entry && controller.workspaces.length > 1 && (
          <p className="text-center text-xs text-muted">左の一覧から別のワークスペースに切り替えられます</p>
        )}
        {onInvite && !adding && (
          <button type="button" onClick={onInvite} className="block w-full text-center text-xs text-muted hover:text-ink hover:underline">
            招待リンクをお持ちの方はこちら
          </button>
        )}
      </form>
    </AuthShell>
  );
}

/** The Tauri app while Google sign-in is open in the system browser, and while its ticket is exchanged. */
function SsoWaiting({ controller }: { controller: AppController }) {
  const waiting = controller.ssoState === "waiting";
  return (
    <AuthShell>
      <div className="space-y-4 text-center" role="status">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-line bg-panel">
          {waiting ? <GoogleMark /> : <Loader2 size={20} className="animate-spin text-muted" />}
        </span>
        <h1 className="text-lg font-bold tracking-tight">{waiting ? "ブラウザでログインを続けてください" : "ログイン中…"}</h1>
        {waiting && (
          <>
            <p className="text-sm text-muted">Google でのログインが終わると、このアプリに戻ります。</p>
            <Button type="button" variant="secondary" className="w-full" onClick={() => controller.cancelGoogleSignIn()}>
              キャンセル
            </Button>
          </>
        )}
      </div>
    </AuthShell>
  );
}

/** Google's "G" as its sign-in button guidelines show it. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
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
