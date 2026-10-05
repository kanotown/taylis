import { CalendarCheck, CalendarDays, EyeOff, Star, Table2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { CalendarEventOut, PollAnswer, PollOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { CalendarEventDialog } from "./CalendarEventDialog";
import { Button, cn, Modal } from "./primitives";
import {
  ANSWER_MARK,
  ANSWER_NAME,
  bestSlots,
  MAX_COMMENT,
  myAnswers,
  myComment,
  pressAnswer,
  respondentCount,
  slotCounts,
} from "./scheduling";
import { t } from "../i18n";

const ANSWERS: readonly PollAnswer[] = ["yes", "maybe", "no"];
const NEXT: Record<string, PollAnswer | null> = { none: "yes", yes: "maybe", maybe: "no", no: null };

const MARK_TONE: Record<PollAnswer, string> = {
  yes: "text-success",
  maybe: "text-warning",
  no: "text-muted",
};

/** Who may decide (SCHEDULING.md §1): the poll's author, the channel's owners, administrators. */
export function canDecide(controller: AppController, message: MessageState): boolean {
  const me = controller.store.me?.id;
  if (!me) return false;
  const channel = controller.store.getChannel(message.channel_id);
  return message.sender_id === me || controller.isAdmin || channel?.membership?.role === "owner";
}

function CountLine({ yes, maybe, no, className }: { yes: number; maybe: number; no: number; className?: string }) {
  return (
    <span className={cn("shrink-0 tabular-nums text-xs text-muted", className)} aria-label={t("schedule.counts", { yes, maybe, no })}>
      <span className={MARK_TONE.yes}>○</span> {yes} · <span className={MARK_TONE.maybe}>△</span> {maybe} · × {no}
    </span>
  );
}

/** The three answer buttons of one candidate; pressing my answer again takes it back. */
function AnswerButtons({ label, current, disabled, onPress }: { label: string; current: PollAnswer | null; disabled: boolean; onPress: (answer: PollAnswer) => void }) {
  return (
    <div className="flex shrink-0 gap-0.5" role="group" aria-label={t("schedule.answerFor", { label })}>
      {ANSWERS.map((answer) => {
        const on = current === answer;
        return (
          <button
            key={answer}
            type="button"
            aria-label={`${label}: ${ANSWER_NAME[answer]}`}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onPress(answer)}
            className={cn(
              "flex h-7 w-8 items-center justify-center rounded-md border text-sm font-semibold transition-colors max-md:h-9 max-md:w-11",
              on ? "border-accent bg-accent-solid text-white" : cn("border-line bg-canvas hover:border-accent/60", MARK_TONE[answer]),
              disabled && "cursor-default opacity-60 hover:border-line",
            )}
          >
            {ANSWER_MARK[answer]}
          </button>
        );
      })}
    </div>
  );
}

/** My comment: kept in the field until sent (Enter or 「保存」). */
function CommentField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const changed = text.trim() !== value;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (changed && !disabled) await onSave(text.trim());
  };
  return (
    <form className="flex items-center gap-1.5" onSubmit={(event) => void submit(event)}>
      <input
        value={text}
        maxLength={MAX_COMMENT}
        disabled={disabled}
        aria-label={t("schedule.comment")}
        placeholder={t("schedule.commentPlaceholder")}
        onChange={(e) => setText(e.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
      />
      {changed && !disabled && <Button type="submit" size="sm">{t("common.save")}</Button>}
    </form>
  );
}

/**
 * A scheduling poll under its message (M53, SCHEDULING.md §5): per candidate the ○ △ × counts and my three buttons, the
 * candidate with the most ○ starred, my comment, 「表で見る」 (people × candidates), and for its author, the channel's
 * owners and administrators 「この日に決める」. Once decided the card shows the decided candidate first, with the event
 * the decision made, and 「決定を取り消す」.
 */
export function ScheduleCard({ poll, message, controller, readOnly = false }: { poll: PollOut; message: MessageState; controller: AppController; readOnly?: boolean }) {
  const me = controller.store.me?.id;
  const mine = myAnswers(poll, me);
  const counts = slotCounts(poll);
  const best = new Set(bestSlots(poll));
  const decided = poll.decided ?? null;
  const closed = !!poll.closed_at || !!decided;
  const disabled = readOnly || closed || !!message.pending;
  const decider = !readOnly && !message.pending && canDecide(controller, message);
  const [table, setTable] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [event, setEvent] = useState<CalendarEventOut | null>(null);
  const dm = controller.store.getChannel(message.channel_id)?.type === "dm" || controller.store.getChannel(message.channel_id)?.type === "group_dm";

  const press = (index: number, answer: PollAnswer) => void controller.answerSchedule(message, pressAnswer(mine, index, answer));
  const openEvent = async () => {
    if (!decided?.event_id) return;
    const found = await controller.loadCalendarEvent(decided.event_id);
    if (found) setEvent(found);
  };

  return (
    <div className="mt-1.5 max-w-xl rounded-xl border border-line bg-panel/60 p-3 text-sm" data-schedule-poll>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">📅 {poll.question}</span>
        <span className="text-xs text-muted">{t("composer.schedulePoll")}</span>
        {poll.anonymous && (
          <span className="inline-flex items-center gap-1 self-center rounded-md bg-panel-2 px-1.5 py-px text-[11px] font-medium text-muted" title={t("schedule.anonymousTitle")}>
            <EyeOff size={11} /> {t("poll.anonymous")}
          </span>
        )}
      </div>

      {decided && (
        <div className="mt-2 rounded-lg border border-accent/40 bg-accent-soft/60 px-3 py-2" data-decided>
          <div className="flex items-center gap-1.5 text-xs font-medium text-accent">
            <CalendarCheck size={14} /> {t("schedule.decided")}
          </div>
          <div className="mt-0.5 text-base font-semibold">{poll.options[decided.index]}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <CountLine {...(counts[decided.index] ?? { yes: 0, maybe: 0, no: 0 })} />
            {decided.event_id && (
              <Button variant="link" size="sm" className="h-6 px-0" onClick={() => void openEvent()}>
                <CalendarDays size={13} /> {t("schedule.openEvent")}
              </Button>
            )}
            {decider && (
              <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => void controller.undecideSchedule(message)}>{t("schedule.undecide")}</Button>
            )}
          </div>
        </div>
      )}

      <ul className="mt-2 space-y-1" aria-label={t("schedule.candidates")}>
        {poll.options.map((label, index) => {
          const count = counts[index]!;
          const chosen = decided?.index === index;
          return (
            <li
              key={index}
              data-slot={index}
              className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5", chosen ? "border-accent bg-accent-soft/40" : "border-line bg-canvas", decided && !chosen && "opacity-70")}
            >
              <span className="flex min-w-[8.5rem] flex-1 items-center gap-1">
                {best.has(index) && <Star size={13} className="shrink-0 fill-amber-400 text-amber-400" aria-label={t("schedule.mostYes")} />}
                <span className="truncate">{label}</span>
              </span>
              <CountLine {...count} />
              <AnswerButtons label={label} current={mine[index] ?? null} disabled={disabled} onPress={(answer) => press(index, answer)} />
              {decider && !decided && (
                <Button size="sm" variant="ghost" className="h-7 text-accent" aria-label={t("schedule.decideOn", { label })} onClick={() => setConfirm(index)}>
                  {t("schedule.decide")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {!readOnly && (!disabled || !!myComment(poll, me)) && (
        <div className="mt-2">
          <CommentField value={myComment(poll, me)} disabled={disabled} onSave={(text) => controller.answerSchedule(message, mine, text)} />
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>{decided ? t("schedule.decidedCount", { count: respondentCount(poll) }) : closed ? t("schedule.closedCount", { count: respondentCount(poll) }) : t("schedule.answeredCount", { count: respondentCount(poll) })}</span>
        <Button size="sm" variant="ghost" onClick={() => setTable(true)}>
          <Table2 size={13} /> {t("schedule.table")}
        </Button>
      </div>

      {table && <ScheduleTableDialog poll={poll} message={message} controller={controller} readOnly={readOnly} onClose={() => setTable(false)} />}
      {confirm !== null && (
        <Modal title={t("schedule.decideTitle")} description={poll.options[confirm]} onClose={() => setConfirm(null)} className="w-[400px]">
          <p className="mt-3 text-sm">
            {dm ? t("schedule.decideNoteDm") : t("schedule.decideNote")}
            {t("schedule.decideCloses")}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => {
                const index = confirm;
                setConfirm(null);
                void controller.decideSchedule(message, index);
              }}
            >
              {t("schedule.decided")}
            </Button>
          </div>
        </Modal>
      )}
      {event && <CalendarEventDialog controller={controller} event={event} onClose={() => setEvent(null)} />}
    </div>
  );
}

/**
 * 「表で見る」: people × candidates like 調整さん, the counts first, then each person's ○ △ × and comment. My row can be
 * changed here (a cell goes ○ → △ → × → unanswered). An anonymous poll has the counts, my row and the comments unnamed.
 */
export function ScheduleTableDialog({ poll, message, controller, readOnly, onClose }: { poll: PollOut; message: MessageState; controller: AppController; readOnly: boolean; onClose: () => void }) {
  const me = controller.store.me?.id ?? null;
  const mine = myAnswers(poll, me);
  const counts = slotCounts(poll);
  const best = new Set(bestSlots(poll));
  const editable = !readOnly && !poll.closed_at && !poll.decided && !message.pending;
  const name = (id: string) => controller.store.users.get(id)?.display_name ?? "?";
  const people = poll.anonymous ? [] : (poll.respondents ?? []).filter((id) => id !== me);
  const answerOf = (userId: string, index: number): PollAnswer | null => {
    const answers = poll.answers?.[index];
    if (!answers) return null;
    return answers.yes.includes(userId) ? "yes" : answers.maybe.includes(userId) ? "maybe" : answers.no.includes(userId) ? "no" : null;
  };
  const commentOf = (userId: string) => poll.comments?.find((c) => c.user_id === userId)?.text ?? "";
  const cycle = (index: number) => {
    const next = NEXT[mine[index] ?? "none"] ?? null;
    void controller.answerSchedule(message, mine.map((value, i) => (i === index ? next : value)));
  };
  const mark = (answer: PollAnswer | null) => (answer ? <span className={cn("font-semibold", MARK_TONE[answer])}>{ANSWER_MARK[answer]}</span> : <span className="text-muted/50">-</span>);
  const cell = "border-b border-line px-2 py-1.5 text-center";

  return (
    <Modal title={poll.question} description={t("schedule.answers")} onClose={onClose} className="w-[min(92vw,960px)]">
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm" aria-label={t("schedule.answersTable")}>
          <thead>
            <tr>
              <th className="sticky left-0 border-b border-line bg-canvas px-2 py-1.5 text-left text-xs font-medium text-muted">{t("reservations.name")}</th>
              {poll.options.map((label, index) => (
                <th key={index} scope="col" className={cn("min-w-[5.5rem] border-b border-line px-2 py-1.5 text-xs font-medium", poll.decided?.index === index && "bg-accent-soft/60")}>
                  <span className="inline-flex items-center gap-0.5">
                    {best.has(index) && <Star size={11} className="fill-amber-400 text-amber-400" aria-label={t("schedule.mostYes")} />}
                    {label}
                  </span>
                </th>
              ))}
              <th className="min-w-[10rem] border-b border-line px-2 py-1.5 text-left text-xs font-medium text-muted">{t("canvas.comments")}</th>
            </tr>
          </thead>
          <tbody>
            <tr data-row="counts">
              <th scope="row" className="sticky left-0 border-b border-line bg-canvas px-2 py-1.5 text-left text-xs font-medium text-muted">{t("schedule.total")}</th>
              {counts.map((count, index) => (
                <td key={index} className={cn(cell, "whitespace-nowrap text-xs")}>
                  <span className={MARK_TONE.yes}>○</span>{count.yes} <span className={MARK_TONE.maybe}>△</span>{count.maybe} ×{count.no}
                </td>
              ))}
              <td className="border-b border-line" />
            </tr>
            {me && (
              <tr data-row="me" className="bg-accent-soft/20">
                <th scope="row" className="sticky left-0 border-b border-line bg-canvas px-2 py-1.5 text-left font-medium">{name(me)} {t("tasks.dialog.me")}</th>
                {poll.options.map((label, index) => (
                  <td key={index} className={cell}>
                    {editable ? (
                      <button type="button" aria-label={t("schedule.myAnswer", { label, answer: mine[index] ? ANSWER_NAME[mine[index]!] : t("schedule.noAnswer") })} className="h-7 w-9 rounded-md border border-line bg-canvas hover:border-accent" onClick={() => cycle(index)}>
                        {mark(mine[index] ?? null)}
                      </button>
                    ) : (
                      mark(mine[index] ?? null)
                    )}
                  </td>
                ))}
                <td className="border-b border-line px-2 py-1">
                  {editable ? <CommentField value={myComment(poll, me)} disabled={false} onSave={(text) => controller.answerSchedule(message, mine, text)} /> : <span className="text-sm">{myComment(poll, me)}</span>}
                </td>
              </tr>
            )}
            {people.map((userId) => (
              <tr key={userId} data-row={userId}>
                <th scope="row" className="sticky left-0 border-b border-line bg-canvas px-2 py-1.5 text-left font-normal">{name(userId)}</th>
                {poll.options.map((_, index) => <td key={index} className={cell}>{mark(answerOf(userId, index))}</td>)}
                <td className="border-b border-line px-2 py-1.5 text-sm">{commentOf(userId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {poll.anonymous && (poll.comments?.length ?? 0) > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-muted">{t("schedule.commentsAnonymous")}</div>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {poll.comments!.map((c, i) => <li key={i}>{c.text}</li>)}
          </ul>
        </div>
      )}
      {!poll.anonymous && people.length === 0 && <p className="mt-3 text-sm text-muted">{t("schedule.noAnswersYet")}</p>}
    </Modal>
  );
}
