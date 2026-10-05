import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { Button, Field, Input, Modal } from "./primitives";
import { t } from "../i18n";

/** The server's limits (messages/schemas.py PollCreate): 2-10 options of 1-80 characters, a question of 1-200. */
export const POLL_MAX_OPTIONS = 10;

/** What is wrong with a poll before it is sent, in the words the form shows; null when it can be sent. */
export function pollProblem(question: string, options: readonly string[]): string | null {
  const filled = options.map((o) => o.trim()).filter(Boolean);
  if (!question.trim()) return t("poll.check.question");
  if (filled.length < 2) return t("poll.check.options");
  if (new Set(filled.map((o) => o.toLowerCase())).size !== filled.length) return t("poll.check.duplicate");
  return null;
}

/**
 * 「アンケートを作成」 (testers asked for a form like Polly, and for polls with several answers): a question, 2-10
 * options, whether one person may pick several, and whether it is anonymous (M27: nobody sees who voted, only how many;
 * fixed once made). `/poll 質問 | A | B` still makes a named single-answer poll at once.
 */
export function PollDialog({ controller, channelId, parentId, onClose, initial }: {
  controller: AppController;
  channelId: string;
  parentId: string | null;
  onClose: () => void;
  /** What the form starts with (M30: `/日程` alone offers the next weekdays, several answers allowed). */
  initial?: { question?: string; options?: string[]; multiple?: boolean };
}) {
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [options, setOptions] = useState(() => {
    const start = (initial?.options ?? []).slice(0, POLL_MAX_OPTIONS);
    return start.length >= 2 ? start : [...start, "", ""].slice(0, 2);
  });
  const [multiple, setMultiple] = useState(initial?.multiple ?? false);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const problem = pollProblem(question, options);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    const made = await controller.createPoll(channelId, parentId, question.trim(), options.map((o) => o.trim()).filter(Boolean), multiple, anonymous);
    setBusy(false);
    if (made) onClose();
  };

  return (
    <Modal onClose={onClose} title={t("poll.create")} className="w-[460px]">
      <form className="mt-3 space-y-3" onSubmit={(event) => void submit(event)}>
        <Field label={t("poll.question")}>
          <Input value={question} maxLength={200} autoFocus placeholder={t("poll.questionPlaceholder")} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted">{t("poll.options")}</span>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={option}
                maxLength={80}
                aria-label={t("workflow.option", { n: index + 1 })}
                placeholder={t("workflow.option", { n: index + 1 })}
                onChange={(e) => setOptions((all) => all.map((o, i) => (i === index ? e.target.value : o)))}
              />
              {options.length > 2 && (
                <button type="button" aria-label={t("poll.removeOption", { n: index + 1 })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={() => setOptions((all) => all.filter((_, i) => i !== index))}>
                  <X size={15} />
                </button>
              )}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setOptions((all) => [...all, ""])}>
              <Plus size={14} /> {t("poll.addOption")}
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          {t("poll.allowMultiple")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          {t("poll.anonymousLabel")}
        </label>
        {tried && problem && <p className="text-xs text-danger">{problem}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy}>{busy ? t("common.creating") : t("common.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}
