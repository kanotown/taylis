import { Copy, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { TotpSetupOut } from "../api/types";
import type { AppController } from "../state/app";
import { Button, Field, Input, Modal } from "./primitives";
import { normalizeTotpInput, recoveryCodesText } from "./totp";

/** Turning 2FA on (M12i): password → scan the QR and confirm a code → keep the recovery codes. */
export function TotpSetupDialog({ controller, onClose, onEnabled }: { controller: AppController; onClose: () => void; onEnabled: () => void }) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TotpSetupOut | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await controller.beginTotpSetup(password);
    setBusy(false);
    if ("error" in result) setError(result.error);
    else setSetup(result);
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await controller.enableTotp(normalizeTotpInput(code));
    setBusy(false);
    if ("error" in result) setError(result.error);
    else setRecovery(result.recovery_codes);
  };

  const copyCodes = async () => {
    if (!recovery) return;
    try {
      await navigator.clipboard.writeText(recoveryCodesText(recovery));
      setCopied(true);
    } catch (err) {
      controller.setError(err);
    }
  };

  return (
    <Modal onClose={recovery ? onEnabled : onClose} title="2 要素認証を有効にする" className="w-[460px]" hideClose={!!recovery}>
      {recovery ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
            <ShieldCheck size={18} /> 有効になりました。次回のログインから認証アプリのコードが必要です。
          </div>
          <p className="text-sm text-muted">回復コードを安全な場所に保存してください。認証アプリが使えないとき、各コードは 1 回だけログインに使えます。この画面を閉じると再表示できません。</p>
          <ul className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-panel p-3 font-mono text-sm">
            {recovery.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => void copyCodes()}>
              <Copy size={14} /> {copied ? "コピーしました" : "回復コードをコピー"}
            </Button>
            <Button size="sm" onClick={onEnabled}>保存しました、閉じる</Button>
          </div>
        </div>
      ) : setup ? (
        <form className="mt-4 space-y-3" onSubmit={confirm}>
          <p className="text-sm text-muted">認証アプリ (Google Authenticator、1Password など) で QR コードを読み取るか、キーを手で入力してください。</p>
          <div className="flex items-start gap-4">
            <img src={`data:image/png;base64,${setup.qr_png_base64}`} alt="認証アプリ用の QR コード" width={168} height={168} className="shrink-0 rounded-lg border border-line bg-white" />
            <div className="min-w-0 space-y-2 text-sm">
              <div className="text-xs text-muted">手入力用のキー</div>
              <code className="block break-all rounded bg-panel px-2 py-1 font-mono text-xs">{setup.secret}</code>
              <div className="text-xs text-muted">種類: 時間ベース (TOTP)、6 桁、30 秒</div>
            </div>
          </div>
          <Field label="アプリに表示された 6 桁のコード">
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
          </Field>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>キャンセル</Button>
            <Button type="submit" size="sm" disabled={busy || normalizeTotpInput(code).length !== 6}>確認して有効にする</Button>
          </div>
        </form>
      ) : (
        <form className="mt-4 space-y-3" onSubmit={begin}>
          <p className="text-sm text-muted">ログイン時にパスワードに加えて認証アプリの 6 桁のコードを求めます。始めるにはパスワードを入力してください。</p>
          <Field label="現在のパスワード">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
          </Field>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>キャンセル</Button>
            <Button type="submit" size="sm" disabled={busy || !password}>次へ</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Turning 2FA off needs the password again. */
export function TotpDisableDialog({ controller, onClose, onDisabled }: { controller: AppController; onClose: () => void; onDisabled: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const failure = await controller.disableTotp(password);
    setBusy(false);
    if (failure) setError(failure);
    else onDisabled();
  };

  return (
    <Modal onClose={onClose} title="2 要素認証を無効にする" className="w-[420px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <p className="text-sm text-muted">以後はパスワードだけでログインできるようになります。回復コードも無効になります。</p>
        <Field label="現在のパスワード">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
        </Field>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>キャンセル</Button>
          <Button type="submit" variant="danger" size="sm" disabled={busy || !password}>無効にする</Button>
        </div>
      </form>
    </Modal>
  );
}
