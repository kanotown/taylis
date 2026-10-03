import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button, cn, Input } from "./primitives";
import { normalizeUsername, renameHint, usernameProblem } from "./username";

/**
 * M96: a username field with its own save button (the profile: my own, 3 times in 24 hours; the admin dialog: anyone's).
 * The local rules show while typing; the server's refusal (taken, reserved, the daily limit) shows under the field.
 * `onSubmit` returns null when done, else the message.
 */
export function UsernameEditor({ current, hasPassword, onSubmit, limitNote, submitLabel = "ユーザー名を変更", autoFocus, onDone }: {
  current: string;
  hasPassword: boolean;
  onSubmit: (username: string) => Promise<string | null>;
  /** Shown only to the person themselves (administrators are not limited). */
  limitNote?: boolean;
  submitLabel?: string;
  autoFocus?: boolean;
  onDone?: (username: string) => void;
}) {
  const [value, setValue] = useState(current);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A rename from elsewhere (another device, an administrator) replaces the field while it shows the old name.
  const shown = useRef(current);
  useEffect(() => {
    const before = shown.current;
    shown.current = current;
    setValue((typed) => (normalizeUsername(typed) === before ? current : typed));
  }, [current]);
  const name = normalizeUsername(value);
  const changed = name !== current;
  const problem = changed ? usernameProblem(value) : null;
  const message = problem ?? serverError;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!changed || problem || busy) return;
    setBusy(true);
    const error = await onSubmit(name);
    setBusy(false);
    setServerError(error);
    if (error === null) {
      setSaved(name);
      onDone?.(name);
    }
  };

  return (
    <form className="space-y-1" onSubmit={submit} aria-label="ユーザー名">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">ユーザー名 (3〜32 文字、a-z 0-9 . _ -)</span>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">@</span>
            <Input
              value={value}
              maxLength={32}
              autoFocus={autoFocus}
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={message ? true : undefined}
              className={cn("pl-7", message && "border-danger")}
              onChange={(e) => { setValue(e.target.value.toLowerCase()); setServerError(null); setSaved(null); }}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || !changed || problem !== null}>
            {submitLabel}
          </Button>
        </div>
      </label>
      {message ? (
        <p role="alert" className="text-xs text-danger">{message}</p>
      ) : saved !== null && !changed ? (
        <p className="text-xs text-muted">@{saved} に変更しました{hasPassword ? "。次からはこの名前でログインします" : ""}</p>
      ) : null}
      <p className="text-xs text-muted">
        {renameHint(hasPassword)}
        {limitNote ? " 変更は 24 時間に 3 回までです。" : ""}
      </p>
    </form>
  );
}
