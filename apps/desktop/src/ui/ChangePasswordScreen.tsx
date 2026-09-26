import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";

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
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>パスワードの変更</h1>
        <p className="muted">仮パスワードでログインしています。続ける前に新しいパスワードを設定してください。</p>
        <label>
          現在のパスワード
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          新しいパスワード (12 文字以上)
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} autoComplete="new-password" required />
        </label>
        <label>
          新しいパスワード (確認)
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </label>
        {mismatch && repeat && <p className="error">パスワードが一致しません</p>}
        {controller.error && <p className="error">{controller.error}</p>}
        <div className="row">
          <button type="submit" disabled={busy || mismatch}>
            変更する
          </button>
          <button type="button" className="secondary" onClick={() => void controller.logout()}>
            ログアウト
          </button>
        </div>
      </form>
    </div>
  );
}
