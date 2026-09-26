import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";

export function LoginScreen({ controller, onDone }: { controller: AppController; onDone: () => void }) {
  const [server, setServer] = useState(controller.serverUrl);
  const [username, setUsername] = useState(controller.username);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await controller.login(server.trim(), username.trim(), password);
    setBusy(false);
    onDone();
  };

  return (
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>ChikuwaChat</h1>
        <label>
          サーバ URL
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://chat.example.com" required />
        </label>
        <label>
          ユーザー名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          パスワード
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {controller.error && <p className="error">{controller.error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "ログイン中…" : "ログイン"}
        </button>
      </form>
    </div>
  );
}
