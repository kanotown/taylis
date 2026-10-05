import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button, cn, Input } from "./primitives";
import { normalizeUsername, renameHint, usernameProblem } from "./username";
import { t } from "../i18n";

/**
 * M96: a username field with its own save button (the profile: my own, 3 times in 24 hours; the admin dialog: anyone's).
 * The local rules show while typing; the server's refusal (taken, reserved, the daily limit) shows under the field.
 * `onSubmit` returns null when done, else the message.
 */
export function UsernameEditor({ current, hasPassword, onSubmit, limitNote, submitLabel = t("admin.users.rename"), autoFocus, onDone }: {
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
    <form className="space-y-1" onSubmit={submit} aria-label={t("admin.users.sort.username")}>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">{t("admin.users.usernameLabel")}</span>
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
        <p className="text-xs text-muted">{t("username.changed", { name: saved })}{hasPassword ? t("username.changedPassword") : ""}</p>
      ) : null}
      <p className="text-xs text-muted">
        {renameHint(hasPassword)}
        {limitNote ? t("username.limit") : ""}
      </p>
    </form>
  );
}
