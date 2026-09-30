import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { Button, Field, Input, Modal } from "./primitives";

/** The server's limits (messages/schemas.py PollCreate): 2-10 options of 1-80 characters, a question of 1-200. */
export const POLL_MAX_OPTIONS = 10;

/** What is wrong with a poll before it is sent, in the words the form shows; null when it can be sent. */
export function pollProblem(question: string, options: readonly string[]): string | null {
  const filled = options.map((o) => o.trim()).filter(Boolean);
  if (!question.trim()) return "質問を入れてください";
  if (filled.length < 2) return "選択肢を 2 つ以上入れてください";
  if (new Set(filled.map((o) => o.toLowerCase())).size !== filled.length) return "同じ選択肢が複数あります";
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
    <Modal onClose={onClose} title="アンケートを作成" className="w-[460px]">
      <form className="mt-3 space-y-3" onSubmit={(event) => void submit(event)}>
        <Field label="質問">
          <Input value={question} maxLength={200} autoFocus placeholder="例: 次回のミーティングはいつにしますか？" onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted">選択肢</span>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={option}
                maxLength={80}
                aria-label={`選択肢 ${index + 1}`}
                placeholder={`選択肢 ${index + 1}`}
                onChange={(e) => setOptions((all) => all.map((o, i) => (i === index ? e.target.value : o)))}
              />
              {options.length > 2 && (
                <button type="button" aria-label={`選択肢 ${index + 1} を削除`} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={() => setOptions((all) => all.filter((_, i) => i !== index))}>
                  <X size={15} />
                </button>
              )}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setOptions((all) => [...all, ""])}>
              <Plus size={14} /> 選択肢を追加
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          複数選択を許可する
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          匿名にする (誰が投票したか表示しない)
        </label>
        {tried && problem && <p className="text-xs text-danger">{problem}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy}>{busy ? "作成中…" : "作成"}</Button>
        </div>
      </form>
    </Modal>
  );
}
