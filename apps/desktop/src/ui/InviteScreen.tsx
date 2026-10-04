import { ArrowLeft, Loader2, Ticket } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { InvitePreviewOut } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { inviteErrorText, parseInviteLink } from "./invite";
import { AuthShell } from "./LoginScreen";
import { Button, Field, Input } from "./primitives";
import { inviteLabLine } from "./roster";

/** Joining with an invite link (M12h): paste the link, see who invites, choose a name and a password. */
export function InviteScreen({ controller, onBack, onDone, initialLink }: { controller: AppController; onBack: () => void; onDone: () => void; initialLink?: string }) {
  const [link, setLink] = useState(initialLink ?? "");
  const [target, setTarget] = useState<{ server: string; token: string } | null>(null);
  const [preview, setPreview] = useState<InvitePreviewOut | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const minLength = preview?.password_min_length ?? 8;
  const mismatch = repeat !== "" && password !== repeat;

  const check = async (event: FormEvent) => {
    event.preventDefault();
    await runCheck();
  };
  useEffect(() => {
    if (initialLink) void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = async () => {
    const parsed = parseInviteLink(link);
    if (!parsed) {
      setError("招待リンクの形式が正しくありません (https://サーバ/invite/… の形です)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPreview(await controller.previewInvite(parsed.server, parsed.token));
      setTarget(parsed);
    } catch (err) {
      setError(inviteErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || mismatch) return;
    setBusy(true);
    setError(null);
    const failure = await controller.acceptInvite(target.server, target.token, { username: username.trim(), display_name: displayName.trim(), password });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onDone();
  };

  return (
    <AuthShell>
      <form className="space-y-4" onSubmit={target ? join : check}>
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-solid text-white shadow-md">
            <Ticket size={24} />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">招待リンクで参加</h1>
            <p className="text-xs text-muted">管理者から受け取ったリンクでアカウントを作ります</p>
          </div>
        </div>
        {!target ? (
          <Field label="招待リンク">
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://chat.example.com/invite/…" required autoFocus autoCapitalize="off" spellCheck={false} />
          </Field>
        ) : (
          <>
            <div className="rounded-xl border border-accent/40 bg-accent-soft/50 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{preview?.invited_by}</span> さんから招待されています{preview?.role === "admin" && " (管理者として参加します)"}
              </div>
              {preview?.lab && <div className="mt-0.5 text-xs">{inviteLabLine(preview.lab)}</div>}
              {preview && preview.channels.length > 0 && <div className="mt-0.5 text-xs text-muted">参加するチャンネル: {preview.channels.map((name) => `#${name}`).join(" ")}</div>}
              {preview && <div className="text-xs text-muted">有効期限: {fullTimestamp(preview.expires_at)} · サーバ {target.server}</div>}
            </div>
            <Field label="ユーザー名 (3〜32 文字、a-z 0-9 . _ -)">
              <Input value={username} pattern="[a-z0-9._-]{3,32}" required autoFocus autoCapitalize="off" autoComplete="username" onChange={(e) => setUsername(e.target.value.toLowerCase())} />
            </Field>
            <Field label="表示名">
              <Input value={displayName} maxLength={80} required onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label={`パスワード (${minLength} 文字以上)`}>
              <Input type="password" value={password} minLength={minLength} autoComplete="new-password" required onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="パスワード (確認)">
              <Input type="password" value={repeat} autoComplete="new-password" required onChange={(e) => setRepeat(e.target.value)} />
            </Field>
            {mismatch && <p className="text-sm text-danger">パスワードが一致しません</p>}
          </>
        )}
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={busy || (!!target && mismatch)} className="w-full">
          {busy && <Loader2 size={16} className="animate-spin" />}
          {target ? (busy ? "参加しています…" : "参加する") : busy ? "確認中…" : "リンクを確認"}
        </Button>
        <button type="button" onClick={target ? () => { setTarget(null); setPreview(null); setError(null); } : onBack} className="flex w-full items-center justify-center gap-1 text-xs text-muted hover:text-ink hover:underline">
          <ArrowLeft size={12} /> {target ? "別のリンクを使う" : "ログイン画面に戻る"}
        </button>
      </form>
    </AuthShell>
  );
}
