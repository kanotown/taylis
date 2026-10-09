/**
 * Workflows (M94, docs/WORKFLOWS.md §7): the form that posts a message (opened from the composer's 「＋」, the header's
 * ⋯, `/name` and `/wf name`, and the 「⚡ name」 label on a message it posted), the list a channel offers, and for the
 * target channel's owners and administrators the list of workflows with the editor (fields, template, live preview).
 */
import { ArrowDown, ArrowUp, Pause, Pencil, Play, Plus, SmilePlus, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { FieldDefault, WorkflowField, WorkflowFieldType, WorkflowOut, WorkflowTemplateOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { Avatar } from "./Avatar";
import { EmojiPicker, readRecentEmoji } from "./EmojiPicker";
import { MessageBody } from "./MessageBody";
import { Button, cn, Field, Input, Modal, PopoverContent, PopoverRoot, PopoverTrigger, Textarea } from "./primitives";
import { SectionIcon } from "./SectionDialog";
import {
  DEFAULT_EMOJI,
  FIELD_TYPES,
  type FieldValue,
  initialValues,
  keyFromLabel,
  cleanValues,
  MAX_FIELDS,
  MAX_NAME,
  MAX_TEMPLATE,
  MAX_TEXT,
  MAX_TEXTAREA,
  renderPreview,
  runBlockedText,
  sampleValues,
  VALUE_ERROR_TEXT,
  type ValueError,
  type Values,
  WEEKDAYS_JA,
  workflowDraftProblem,
  postsWithoutAsking,
} from "./workflows";
import { t, weekdayName } from "../i18n";

const SELECT =
  "rounded-lg border border-line bg-canvas px-2.5 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";

// --- the lists a channel offers (read when opened, kept a minute: no events, like recurring posts) ----------------

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; list: WorkflowOut[] }>();

/** After a change in the editor every channel's list is read again. */
export function invalidateWorkflowLists(): void {
  cache.clear();
}

/** The workflows a channel offers (null while loading; [] on an older server or a failure). No fetch for null. */
export function useChannelWorkflows(controller: AppController, channelId: string | null, refresh = 0): WorkflowOut[] | null {
  const cached = channelId ? cache.get(channelId) : undefined;
  const [list, setList] = useState<WorkflowOut[] | null>(cached?.list ?? null);
  useEffect(() => {
    const api = controller.api;
    if (!channelId || !api) {
      setList(null);
      return;
    }
    const hit = cache.get(channelId);
    if (hit && Date.now() - hit.at < CACHE_MS && refresh === 0) {
      setList(hit.list);
      return;
    }
    let current = true;
    Promise.resolve()
      .then(() => api.channelWorkflows(channelId))
      .then(
        (rows) => {
          cache.set(channelId, { at: Date.now(), list: rows });
          if (current) setList(rows);
        },
        () => { if (current) setList([]); },
      );
    return () => { current = false; };
  }, [controller, channelId, refresh]);
  return channelId ? list : null;
}

function channelLabel(controller: AppController, channelId: string): string {
  const name = controller.store.channels.get(channelId)?.name;
  return name ? `#${name}` : t("workflow.targetChannel");
}

/** The workflow's emoji (⚡ when none); with the controller a custom `:name:` shows as its image. */
export function WorkflowEmoji({ workflow, className, controller }: { workflow: Pick<WorkflowOut, "emoji">; className?: string; controller?: AppController }) {
  const emoji = workflow.emoji ?? DEFAULT_EMOJI;
  return (
    <span className={cn("inline-flex w-5 shrink-0 justify-center text-base leading-none", className)} aria-hidden>
      {controller ? <SectionIcon controller={controller} emoji={emoji} size={16} /> : emoji}
    </span>
  );
}

/** The run dialog's title: a custom emoji (`:name:`) cannot be drawn in it, so only a Unicode one leads the name. */
function titleOf(workflow: Pick<WorkflowOut, "emoji" | "name">): string {
  const emoji = workflow.emoji ?? DEFAULT_EMOJI;
  return emoji.startsWith(":") ? workflow.name : `${emoji} ${workflow.name}`;
}

/** The menu: the workflows the channel offers, each opening its form (greyed with the reason when it cannot run). */
export function WorkflowList({ controller, channel, workflows, onRun }: { controller: AppController; channel: ChannelState; workflows: WorkflowOut[] | null; onRun: (workflow: WorkflowOut) => void }) {
  if (workflows === null) return <p className="py-2 text-sm text-muted">{t("common.loading")}</p>;
  if (workflows.length === 0) return <p className="py-2 text-sm text-muted">{t("workflow.noneHere")}</p>;
  return (
    <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t("composer.workflow")}>
      {workflows.map((workflow) => {
        const target = channelLabel(controller, workflow.channel_id);
        const blocked = runBlockedText(workflow, target);
        return (
          <li key={workflow.id}>
            <button
              type="button"
              disabled={!!blocked}
              onClick={() => onRun(workflow)}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-panel disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              data-workflow={workflow.id}
            >
              <WorkflowEmoji workflow={workflow} className="mt-0.5" controller={controller} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{workflow.name}</span>
                {workflow.description && <span className="block truncate text-xs text-muted">{workflow.description}</span>}
                {workflow.channel_id !== channel.id && <span className="block text-xs text-muted">→ {t("workflow.postsTo", { target })}</span>}
                {blocked && <span className="block text-xs text-warning">{blocked}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The composer's 「＋」 → 「ワークフロー…」 and the header's ⋯ → 「ワークフロー…」 (with 「管理」 for its managers). */
export function ChannelWorkflowsDialog({ controller, channel, onClose, manage = false }: { controller: AppController; channel: ChannelState; onClose: () => void; manage?: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const workflows = useChannelWorkflows(controller, channel.id, refresh);
  const [running, setRunning] = useState<WorkflowOut | null>(null);
  const canManage = manage && canManageWorkflows(channel, controller.isAdmin);
  const [managing, setManaging] = useState(false);
  if (running) return <WorkflowRunDialog key={running.id} controller={controller} workflow={running} here={channel.id} onClose={onClose} />;
  return (
    <Modal onClose={onClose} title={t("composer.workflow")} description={managing ? t("workflow.manageDescription", { name: channel.name ?? "" }) : t("workflow.useDescription")} className="w-[560px]">
      {canManage && (
        <div className="mt-3 flex rounded-lg bg-panel-2 p-0.5 text-sm font-medium" role="tablist" aria-label={t("canvas.mode")}>
          {([false, true] as const).map((value) => (
            <button key={String(value)} type="button" role="tab" aria-selected={managing === value} onClick={() => { setManaging(value); if (!value) setRefresh((n) => n + 1); }} className={cn("flex-1 rounded-md px-2.5 py-1.5", managing === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}>
              {value ? t("workflow.manage") : t("workflow.use")}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3">
        {managing ? <WorkflowManager controller={controller} channelId={channel.id} /> : <WorkflowList controller={controller} channel={channel} workflows={workflows} onRun={setRunning} />}
      </div>
    </Modal>
  );
}

export function canManageWorkflows(channel: ChannelState | undefined, isAdmin: boolean): boolean {
  if (!channel || channel.archived || (channel.type !== "public" && channel.type !== "private")) return false;
  return channel.membership?.role === "owner" || (isAdmin && (channel.isMember || channel.type === "public"));
}

// --- the form ---------------------------------------------------------------------------------------------------

/**
 * Fills and posts one workflow. One idempotency key per open form: pressing 投稿 again after a failure never posts twice.
 * A workflow that does not ask first (`confirm` off and no fields, WORKFLOWS.md §11) posts as soon as this opens and
 * shows nothing; only when that fails does the dialog appear, with the reason and the same key for 投稿.
 *
 * The state is made once per mount, so a site that can swap the workflow keys this by `workflow.id`: the next
 * workflow gets its own form and key, and the one it replaced never closes it.
 */
export function WorkflowRunDialog({ controller, workflow, here, onClose, confirmAlways = false }: {
  controller: AppController;
  workflow: WorkflowOut;
  /** The conversation it was opened from: posting elsewhere says where it went. */
  here?: string;
  onClose: () => void;
  /** The form even for a workflow that does not ask (the 「⚡ name」 label on a message: a look, not a re-post). */
  confirmAlways?: boolean;
}) {
  const store = controller.store;
  const me = store.me?.id ?? null;
  const [values, setValues] = useState<Values>(() => initialValues(workflow.fields, new Date(), me));
  const [errors, setErrors] = useState<Record<string, ValueError>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef<string>(crypto.randomUUID());
  const quick = !confirmAlways && postsWithoutAsking(workflow);
  // Hidden while the immediate post is under way; shown when it failed (or for every workflow that asks).
  const [shown, setShown] = useState(!quick);
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const preview = useMemo(() => renderPreview(workflow.template, workflow.fields, values), [workflow, values]);
  const target = channelLabel(controller, workflow.channel_id);
  const set = (fieldKey: string, value: FieldValue) => {
    setValues((current) => ({ ...current, [fieldKey]: value }));
    setErrors((current) => {
      if (!(fieldKey in current)) return current;
      const next = { ...current };
      delete next[fieldKey];
      return next;
    });
    setProblem(null);
  };
  const submit = async () => {
    if (busy) return;
    const checked = cleanValues(workflow.fields, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      setProblem(t("workflow.checkInput"));
      return;
    }
    setBusy(true);
    const result = await controller.submitWorkflow(workflow.id, checked.values, key.current);
    const posted = result.ok && !!here && result.message.channel_id !== here;
    if (!mounted.current) {
      // Replaced by another workflow's form while posting: the post still went through (or not), but this form is
      // gone, so only the toasts remain, and onClose would close the form that took its place.
      if (posted) controller.setNotice(t("workflow.posted", { target }));
      else if (!result.ok) controller.setError(result.error);
      return;
    }
    setBusy(false);
    if (result.ok) {
      if (posted) controller.setNotice(t("workflow.posted", { target }));
      onClose();
      return;
    }
    setShown(true);
    const error = result.error;
    if (error instanceof ApiError && error.code === "workflow_values_invalid") {
      const fields = (error.details as { fields?: Record<string, ValueError> } | undefined)?.fields ?? {};
      setErrors(fields);
    }
    setProblem(describeError(error));
  };
  useEffect(() => {
    if (!quick || started.current) return;
    started.current = true;
    void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it opens
  }, []);
  if (!shown) return null;
  return (
    <Modal onClose={onClose} title={titleOf(workflow)} description={workflow.description || t("workflow.willPost", { target })} className="w-[560px]">
      <form
        className="mt-4 space-y-3"
        aria-label={workflow.name}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {workflow.fields.map((field, index) => (
          <FieldInput key={field.key} controller={controller} field={field} value={values[field.key]} error={errors[field.key]} autoFocus={index === 0} onChange={(value) => set(field.key, value)} />
        ))}
        <section aria-label={t("composer.preview")} className="rounded-lg border border-line bg-panel/50 px-3 py-2">
          <div className="mb-1 text-[11px] font-semibold text-muted">{t("workflow.previewAs", { target })}</div>
          {preview ? (
            <MessageBody body={preview} users={store.users} groups={store.groups} customEmoji={store.customEmoji} controller={controller} />
          ) : (
            <p className="text-sm text-muted">{t("workflow.empty")}</p>
          )}
        </section>
        {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !workflow.can_run}>{t("workflow.post")}</Button>
        </div>
      </form>
    </Modal>
  );
}

function FieldInput({ controller, field, value, error, autoFocus, onChange }: {
  controller: AppController;
  field: WorkflowField;
  value: FieldValue | undefined;
  error: ValueError | undefined;
  autoFocus: boolean;
  onChange: (value: FieldValue) => void;
}) {
  const id = `wf-${field.key}`;
  const text = typeof value === "string" ? value : "";
  const label = (
    <span className="text-xs font-medium text-muted">
      {field.label}
      {field.required && <span className="ml-0.5 text-danger" aria-label={t("workflow.required")}>*</span>}
    </span>
  );
  let input: React.ReactNode;
  switch (field.type) {
    case "textarea":
      input = <Textarea id={id} rows={3} autoFocus={autoFocus} value={text} maxLength={MAX_TEXTAREA} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "date":
      input = <Input id={id} type="date" autoFocus={autoFocus} value={text} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} className="w-48" />;
      break;
    case "time":
      input = <Input id={id} type="time" autoFocus={autoFocus} value={text} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} className="w-32" />;
      break;
    case "datetime":
      input = <Input id={id} type="datetime-local" autoFocus={autoFocus} value={text} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} className="w-60" />;
      break;
    case "select":
      input = (
        <select id={id} autoFocus={autoFocus} className={SELECT} value={text} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("workflow.choose")}</option>
          {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      );
      break;
    case "user":
      input = <PeoplePicker controller={controller} id={id} multiple={field.multiple} value={Array.isArray(value) ? value : []} onChange={onChange} />;
      break;
    case "checkbox":
      return (
        <div className="space-y-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input id={id} type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            {field.label}
            {field.required && <span className="text-danger" aria-label={t("workflow.required")}>*</span>}
          </label>
          {field.help && <span className="block text-xs text-muted">{field.help}</span>}
          {error && <span role="alert" className="block text-xs text-danger">{VALUE_ERROR_TEXT[error]}</span>}
        </div>
      );
    default:
      input = <Input id={id} autoFocus={autoFocus} value={text} maxLength={MAX_TEXT} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="space-y-1" data-workflow-field={field.key}>
      <label htmlFor={id} className="block">{label}</label>
      {input}
      {field.help && <span className="block text-xs text-muted">{field.help}</span>}
      {error && <span role="alert" className="block text-xs text-danger">{VALUE_ERROR_TEXT[error]}</span>}
    </div>
  );
}

/** People (active, not bots): the chosen as chips, the rest in a list filtered by name. */
function PeoplePicker({ controller, id, multiple, value, onChange }: { controller: AppController; id: string; multiple: boolean; value: string[]; onChange: (value: string[]) => void }) {
  const store = controller.store;
  const [query, setQuery] = useState("");
  const people = useMemo(
    () => [...store.users.values()].filter((u) => u.role !== "bot" && !u.deactivated_at).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja")),
    [store.users],
  );
  const q = query.trim().toLowerCase();
  const shown = people.filter((p) => !value.includes(p.id) && (!q || p.display_name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))).slice(0, 30);
  const pick = (personId: string) => {
    onChange(multiple ? [...value, personId] : [personId]);
    setQuery("");
  };
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={t("workflow.chosenPeople")}>
          {value.map((personId) => {
            const name = store.users.get(personId)?.display_name ?? "?";
            return (
              <span key={personId} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-1 pr-1.5 text-xs font-medium text-accent">
                <Avatar id={personId} name={name} size={18} />
                {name}
                <button type="button" aria-label={t("workflow.removePerson", { name })} className="rounded-full hover:bg-accent/15" onClick={() => onChange(value.filter((v) => v !== personId))}>
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {(multiple || value.length === 0) && (
        <>
          <Input id={id} value={query} placeholder={t("workflow.searchName")} className="h-8 text-sm" onChange={(e) => setQuery(e.target.value)} />
          {q && (
            <ul className="max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line" aria-label={t("workflow.candidates")}>
              {shown.length === 0 ? (
                <li className="px-2.5 py-1.5 text-sm text-muted">{t("workflow.notFound")}</li>
              ) : (
                shown.map((person) => (
                  <li key={person.id}>
                    <button type="button" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-panel" onClick={() => pick(person.id)}>
                      <Avatar id={person.id} name={person.display_name} size={20} />
                      <span className="min-w-0 flex-1 truncate">{person.display_name}</span>
                      <span className="shrink-0 text-xs text-muted">@{person.username}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Above a message a workflow posted: 「⚡ name」; it opens that workflow's form when I can still use it. Always the form
 * (WORKFLOWS.md §11.3): a label on an old message is looked at far more often than meant as a post, so even a workflow
 * that posts at once from the menu asks here.
 */
export function WorkflowLabel({ controller, message }: { controller: AppController; message: MessageState }) {
  const workflow = message.workflow;
  const [open, setOpen] = useState<WorkflowOut | null>(null);
  if (!workflow) return null;
  const openForm = async () => {
    const api = controller.api;
    if (!api) return;
    try {
      const found = await api.getWorkflow(workflow.id);
      if (found.can_run) setOpen(found);
      else controller.setError(runBlockedText(found, channelLabel(controller, found.channel_id)) ?? t("workflow.cannotUse"));
    } catch (error) {
      controller.setError(error);
    }
  };
  return (
    <>
      <button type="button" data-workflow-label="" className="mb-0.5 inline-flex max-w-full items-center gap-1 text-[11px] font-medium text-muted hover:text-ink" title={t("workflow.useThis")} onClick={() => void openForm()}>
        <Zap size={11} className="shrink-0 text-warning" />
        <span className="truncate">{workflow.name}</span>
      </button>
      {open && <WorkflowRunDialog key={open.id} controller={controller} workflow={open} confirmAlways onClose={() => setOpen(null)} />}
    </>
  );
}

// --- managing ---------------------------------------------------------------------------------------------------

/** 管理 → 「ワークフロー」 (every workflow I manage), and a channel's 「管理」 (those posting there). */
export function WorkflowManager({ controller, channelId }: { controller: AppController; channelId?: string }) {
  const [rows, setRows] = useState<WorkflowOut[] | "failed" | null>(null);
  const [editing, setEditing] = useState<WorkflowOut | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let current = true;
    Promise.resolve().then(() => api.workflows()).then(
      (list) => { if (current) setRows(channelId ? list.filter((w) => w.channel_id === channelId) : list); },
      () => { if (current) setRows("failed"); },
    );
    return () => { current = false; };
  }, [controller, channelId, reload]);
  const act = useCallback(async (workflow: WorkflowOut, action: () => Promise<unknown>, done: string) => {
    setBusy(workflow.id);
    setResult(null);
    try {
      await action();
      invalidateWorkflowLists();
      setResult({ ok: true, text: done });
      setReload((n) => n + 1);
    } catch (error) {
      setResult({ ok: false, text: describeError(error) });
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  }, []);
  const api = controller.api;
  return (
    <div className="space-y-2 p-1" data-workflow-manager>
      {rows === null ? (
        <p className="py-2 text-sm text-muted">{t("common.loading")}</p>
      ) : rows === "failed" ? (
        <p className="py-2 text-sm text-danger">{t("common.loadFailed")}</p>
      ) : rows.length === 0 ? (
        <p className="py-1 text-sm text-muted">{t("workflow.noneYet")}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((workflow) => (
            <li key={workflow.id} className="space-y-1 px-3 py-2.5" data-workflow-row={workflow.id}>
              <div className="flex items-center gap-2">
                <WorkflowEmoji workflow={workflow} controller={controller} />
                <strong className="min-w-0 flex-1 truncate text-sm">{workflow.name}</strong>
                {!workflow.enabled && <span className="shrink-0 rounded bg-panel-2 px-1.5 text-[11px] font-medium text-muted">{t("workflow.paused")}</span>}
              </div>
              <div className="text-xs text-muted">
                {t("workflow.summary", { target: channelLabel(controller, workflow.channel_id), count: workflow.fields.length })}
                {workflow.offered_channel_ids.length > 1 && <>{t("workflow.offeredIn", { count: workflow.offered_channel_ids.length - 1 })}</>}
              </div>
              {api && (confirmDelete === workflow.id ? (
                <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-2 py-1.5">
                  <span className="mr-auto text-xs">{t("workflow.deleteConfirm", { name: workflow.name })}</span>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</Button>
                  <Button variant="danger" size="sm" disabled={busy === workflow.id} onClick={() => void act(workflow, () => api.deleteWorkflow(workflow.id), t("common.deleted"))}>{t("common.deleteConfirm")}</Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(workflow)}><Pencil size={13} /> {t("canvas.edit")}</Button>
                  <Button variant="secondary" size="sm" disabled={busy === workflow.id} onClick={() => void act(workflow, () => api.updateWorkflow(workflow.id, { enabled: !workflow.enabled }), workflow.enabled ? t("workflow.pausedNotice") : t("workflow.resumedNotice"))}>
                    {workflow.enabled ? <><Pause size={13} /> {t("settings.pause.pause")}</> : <><Play size={13} /> {t("settings.pause.resume")}</>}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(workflow.id)}><Trash2 size={13} /> {t("common.delete")}</Button>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {result && <p role={result.ok ? "status" : "alert"} className={cn("text-xs", result.ok ? "text-muted" : "text-danger")}>{result.text}</p>}
      <Button size="sm" variant="secondary" onClick={() => setEditing("new")} disabled={rows === "failed"}>
        <Plus size={14} /> {t("workflow.create")}
      </Button>
      {editing && (
        <WorkflowEditorDialog
          controller={controller}
          workflow={editing === "new" ? null : editing}
          defaultChannelId={channelId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidateWorkflowLists();
            setResult({ ok: true, text: t("common.saved") });
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

interface Draft {
  name: string;
  emoji: string;
  description: string;
  channelId: string;
  offered: string[];
  fields: WorkflowField[];
  template: string;
  enabled: boolean;
  confirm: boolean;
}

function draftOf(workflow: WorkflowOut | null, channelId: string | undefined): Draft {
  if (!workflow) return { name: "", emoji: "", description: "", channelId: channelId ?? "", offered: [], fields: [], template: "", enabled: true, confirm: true };
  return {
    name: workflow.name,
    emoji: workflow.emoji ?? "",
    description: workflow.description,
    channelId: workflow.channel_id,
    offered: workflow.offered_channel_ids.filter((id) => id !== workflow.channel_id),
    fields: workflow.fields.map((f) => ({ ...f, options: [...(f.options ?? [])] })),
    template: workflow.template,
    enabled: workflow.enabled,
    // An older server leaves it out: it always asked.
    confirm: workflow.confirm ?? true,
  };
}

function newField(type: WorkflowFieldType, taken: string[]): WorkflowField {
  const label = FIELD_TYPES.find(([kind]) => kind === type)?.[1] ?? t("workflow.field");
  return { key: keyFromLabel(label, taken), label, type, required: false, help: "", multiple: false, options: type === "select" ? [t("workflow.option", { n: 1 }), t("workflow.option", { n: 2 })] : [], default: null };
}

/** Create (workflow = null) or edit: name, target, where it is offered, the fields, the template and its preview. */
export function WorkflowEditorDialog({ controller, workflow, defaultChannelId, onClose, onSaved }: {
  controller: AppController;
  workflow: WorkflowOut | null;
  defaultChannelId?: string;
  onClose: () => void;
  onSaved: (workflow: WorkflowOut) => void;
}) {
  const store = controller.store;
  const [draft, setDraft] = useState<Draft>(() => draftOf(workflow, defaultChannelId));
  const [templates, setTemplates] = useState<WorkflowTemplateOut[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const templateArea = useRef<HTMLTextAreaElement>(null);
  const me = store.me?.id ?? null;
  useEffect(() => {
    const api = controller.api;
    if (workflow || !api) return;
    let current = true;
    Promise.resolve().then(() => api.workflowTemplates()).then((list) => { if (current) setTemplates(list); }, () => undefined);
    return () => { current = false; };
  }, [controller, workflow]);
  const set = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const setField = (index: number, patch: Partial<WorkflowField>) => {
    setDraft((current) => {
      const fields = current.fields.map((f, i) => {
        if (i !== index) return f;
        const next = { ...f, ...patch };
        // The key follows the label while it is the one made from the label.
        if (patch.label !== undefined && f.key === keyFromLabel(f.label, current.fields.filter((_, j) => j !== i).map((x) => x.key))) {
          next.key = keyFromLabel(patch.label, current.fields.filter((_, j) => j !== i).map((x) => x.key));
        }
        if (patch.type !== undefined && patch.type !== f.type) {
          next.default = null;
          next.options = patch.type === "select" ? (f.options?.length ? f.options : [t("workflow.option", { n: 1 }), t("workflow.option", { n: 2 })]) : [];
          next.multiple = false;
        }
        return next;
      });
      // A renamed key is renamed in the template too.
      const before = current.fields[index]!;
      const after = fields[index]!;
      const template = before.key !== after.key && after.key ? current.template.split(`{{${before.key}}}`).join(`{{${after.key}}}`) : current.template;
      return { ...current, fields, template };
    });
    setError(null);
  };
  const move = (index: number, by: -1 | 1) => {
    const fields = [...draft.fields];
    const [field] = fields.splice(index, 1);
    fields.splice(index + by, 0, field!);
    set({ fields });
  };
  const insertKey = (key: string) => {
    const el = templateArea.current;
    const token = `{{${key}}}`;
    if (!el) return set({ template: draft.template + token });
    const start = el.selectionStart ?? draft.template.length;
    const end = el.selectionEnd ?? start;
    set({ template: draft.template.slice(0, start) + token + draft.template.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const fromTemplate = (seed: WorkflowTemplateOut) => {
    set({ name: seed.name, emoji: seed.emoji ?? "", description: seed.description, fields: seed.fields.map((f) => ({ ...f, options: [...(f.options ?? [])] })), template: seed.template });
  };
  const targets = [...store.channels.values()].filter((c) => canManageWorkflows(c, controller.isAdmin) || c.id === draft.channelId).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const offerable = [...store.channels.values()].filter((c) => c.isMember && !c.archived && (c.type === "public" || c.type === "private") && c.id !== draft.channelId).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const problem = workflowDraftProblem(draft);
  const preview = useMemo(() => renderPreview(draft.template, draft.fields, sampleValues(draft.fields, new Date(), me)), [draft.template, draft.fields, me]);
  const callsEveryone = /<!(channel|here)>/.test(draft.template);
  const save = async () => {
    const api = controller.api;
    if (!api || busy) return;
    if (problem) return setError(problem);
    setBusy(true);
    const body = {
      name: draft.name.trim(),
      emoji: draft.emoji.trim() || null,
      description: draft.description.trim(),
      channel_id: draft.channelId,
      offered_channel_ids: draft.offered.filter((id) => id !== draft.channelId),
      fields: draft.fields.map((f) => ({ ...f, label: f.label.trim(), options: f.type === "select" ? (f.options ?? []).map((o) => o.trim()) : [] })),
      template: draft.template,
      enabled: draft.enabled,
      confirm: draft.confirm,
    };
    try {
      onSaved(workflow ? await api.updateWorkflow(workflow.id, body) : await api.createWorkflow(body));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  const title = workflow ? t("workflow.edit") : t("workflow.create");
  return (
    <Modal onClose={onClose} title={title} className="w-[720px]">
      <form className="mt-4 space-y-4" aria-label={title} noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {!workflow && templates.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted">{t("workflow.fromTemplate")}</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("workflow.fromTemplate")}>
              {templates.map((seed) => (
                <Button key={seed.key} variant="secondary" size="sm" onClick={() => fromTemplate(seed)}>
                  {seed.emoji ?? DEFAULT_EMOJI} {seed.name}
                </Button>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-[4.5rem_1fr] gap-3 max-sm:grid-cols-1">
          <Field label={t("composer.emoji")}>
            {/* The app's emoji picker (custom emoji too), as for a status or a section: typing one only brought up the keyboard. */}
            <PopoverRoot open={picking} onOpenChange={setPicking}>
              <PopoverTrigger asChild>
                <button type="button" data-workflow-emoji="" aria-label={draft.emoji ? t("status.changeEmoji") : t("status.pickEmoji")} title={t("composer.emoji")} className="flex h-9 w-full items-center justify-center rounded-lg border border-line bg-canvas text-muted hover:bg-panel">
                  {draft.emoji ? <SectionIcon controller={controller} emoji={draft.emoji} size={18} /> : <span className="text-lg leading-none opacity-60">{DEFAULT_EMOJI}</span>}
                  <SmilePlus size={12} className="ml-1 shrink-0" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <EmojiPicker
                  recent={readRecentEmoji()}
                  custom={[...store.customEmoji.values()]}
                  controller={controller}
                  onPick={(entry) => {
                    set({ emoji: entry.glyph });
                    setPicking(false);
                  }}
                />
                {draft.emoji && (
                  <div className="mt-2 border-t border-line pt-2 text-right">
                    <Button type="button" variant="ghost" size="sm" onClick={() => { set({ emoji: "" }); setPicking(false); }}>{t("status.removeEmoji")}</Button>
                  </div>
                )}
              </PopoverContent>
            </PopoverRoot>
          </Field>
          <Field label={t("workflow.nameLabel")}>
            <Input autoFocus value={draft.name} maxLength={MAX_NAME * 2} placeholder={t("workflow.namePlaceholder")} onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </div>
        <Field label={t("workflow.description")}>
          <Input value={draft.description} maxLength={200} placeholder={t("workflow.descriptionPlaceholder")} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label={t("workflow.targetLabel")}>
          <select aria-label={t("workflow.target")} className={cn(SELECT, "w-full")} value={draft.channelId} onChange={(e) => set({ channelId: e.target.value, offered: draft.offered.filter((id) => id !== e.target.value) })}>
            <option value="">{t("workflow.choose")}</option>
            {targets.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </Field>
        {offerable.length > 0 && (
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted">{t("workflow.offerElsewhere", { count: draft.offered.length })}</summary>
            <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto" aria-label={t("workflow.otherChannels")}>
              {offerable.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={draft.offered.includes(c.id)} onChange={(e) => set({ offered: e.target.checked ? [...draft.offered, c.id] : draft.offered.filter((id) => id !== c.id) })} />
                    #{c.name}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}

        <section aria-label={t("workflow.fields")} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">{t("workflow.fieldsCount", { count: draft.fields.length, max: MAX_FIELDS })}</span>
            <select
              aria-label={t("workflow.addField")}
              className={cn(SELECT, "ml-auto py-1 text-xs")}
              value=""
              disabled={draft.fields.length >= MAX_FIELDS}
              onChange={(e) => {
                if (!e.target.value) return;
                const field = newField(e.target.value as WorkflowFieldType, draft.fields.map((f) => f.key));
                set({ fields: [...draft.fields, field] });
              }}
            >
              <option value="">{t("workflow.addFieldOption")}</option>
              {FIELD_TYPES.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
            </select>
          </div>
          {draft.fields.length === 0 && <p className="text-xs text-muted">{t("workflow.noFieldsNote")}</p>}
          <ol className="space-y-2">
            {draft.fields.map((field, index) => (
              <FieldEditor key={index} field={field} index={index} count={draft.fields.length} onChange={(patch) => setField(index, patch)} onMove={(by) => move(index, by)} onRemove={() => set({ fields: draft.fields.filter((_, i) => i !== index) })} onInsert={() => insertKey(field.key)} />
            ))}
          </ol>
        </section>

        <section aria-label={t("workflow.template")} className="space-y-1.5">
          <span className="text-xs font-medium text-muted">{t("workflow.templateNote", { key: "{{" + t("workflow.key") + "}}" })}</span>
          {draft.fields.length > 0 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("workflow.insertField")}>
              {draft.fields.map((f, i) => (
                <button key={i} type="button" className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-panel hover:text-ink" onClick={() => insertKey(f.key)}>
                  {`{{${f.key}}}`}
                </button>
              ))}
            </div>
          )}
          <Textarea ref={templateArea} aria-label={t("workflow.templateShort")} rows={6} className="font-mono text-[13px]" value={draft.template} maxLength={MAX_TEMPLATE} placeholder={t("workflow.templatePlaceholder")} onChange={(e) => set({ template: e.target.value })} />
          {callsEveryone && <p className="text-xs text-warning">{t("workflow.callsEveryone")}</p>}
          <div className="rounded-lg border border-line bg-panel/50 px-3 py-2" aria-label={t("workflow.templatePreview")}>
            <div className="mb-1 text-[11px] font-semibold text-muted">{t("workflow.previewDefaults")}</div>
            {preview ? <MessageBody body={preview} users={store.users} groups={store.groups} customEmoji={store.customEmoji} controller={controller} /> : <p className="text-sm text-muted">{t("workflow.empty")}</p>}
          </div>
        </section>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {t("workflow.enabledLabel")}
        </label>
        <div className="space-y-0.5">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={draft.confirm} onChange={(e) => set({ confirm: e.target.checked })} />
            {t("workflow.confirmLabel")}
          </label>
          {!draft.confirm && <p className="pl-6 text-xs text-muted">{draft.fields.length > 0 ? t("workflow.confirmFieldsNote") : t("workflow.confirmOffNote")}</p>}
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy}>{workflow ? t("common.save") : t("common.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}

function FieldEditor({ field, index, count, onChange, onMove, onRemove, onInsert }: {
  field: WorkflowField;
  index: number;
  count: number;
  onChange: (patch: Partial<WorkflowField>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onInsert: () => void;
}) {
  const typeLabel = FIELD_TYPES.find(([t]) => t === field.type)?.[1] ?? field.type;
  return (
    <li className="space-y-2 rounded-lg border border-line p-2.5" data-field-editor={index}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-center text-xs text-muted">{index + 1}</span>
        <Input aria-label={t("workflow.fieldName", { n: index + 1 })} value={field.label} maxLength={80} className="h-8 min-w-0 flex-1 text-sm" onChange={(e) => onChange({ label: e.target.value })} />
        <select aria-label={t("workflow.fieldType", { n: index + 1 })} className={cn(SELECT, "py-1 text-xs")} value={field.type} onChange={(e) => onChange({ type: e.target.value as WorkflowFieldType })}>
          {FIELD_TYPES.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={field.required} onChange={(e) => onChange({ required: e.target.checked })} />
          {t("workflow.requiredLabel")}
        </label>
        <div className="ml-auto flex items-center">
          <button type="button" aria-label={t("common.moveUp")} disabled={index === 0} className="rounded p-1 text-muted hover:bg-panel disabled:opacity-30" onClick={() => onMove(-1)}><ArrowUp size={13} /></button>
          <button type="button" aria-label={t("common.moveDown")} disabled={index === count - 1} className="rounded p-1 text-muted hover:bg-panel disabled:opacity-30" onClick={() => onMove(1)}><ArrowDown size={13} /></button>
          <button type="button" aria-label={t("workflow.removeField", { field: field.label })} className="rounded p-1 text-danger hover:bg-danger/10" onClick={onRemove}><Trash2 size={13} /></button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-7 text-xs">
        <label className="flex items-center gap-1 text-muted">
          {t("workflow.key")}
          <Input aria-label={t("workflow.fieldKey", { n: index + 1 })} value={field.key} maxLength={30} className="h-7 w-32 font-mono text-xs" onChange={(e) => onChange({ key: e.target.value.normalize("NFC") })} />
        </label>
        <button type="button" className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-panel" title={t("workflow.insertIntoTemplate")} onClick={onInsert}>{t("workflow.insert", { key: `{{${field.key}}}` })}</button>
        <Input aria-label={t("workflow.fieldHelp", { n: index + 1 })} value={field.help} maxLength={200} placeholder={t("workflow.fieldHelpPlaceholder", { type: typeLabel })} className="h-7 min-w-0 flex-1 text-xs" onChange={(e) => onChange({ help: e.target.value })} />
      </div>
      {field.type === "select" && (
        <div className="pl-7">
          <Textarea aria-label={t("workflow.fieldOptions", { n: index + 1 })} rows={Math.min(Math.max(field.options?.length ?? 2, 2), 6)} className="text-xs" value={(field.options ?? []).join("\n")} placeholder={t("workflow.optionsPlaceholder")} onChange={(e) => onChange({ options: e.target.value.split("\n"), default: null })} />
        </div>
      )}
      {field.type === "user" && (
        <label className="flex items-center gap-1.5 pl-7 text-xs">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={field.multiple} onChange={(e) => onChange({ multiple: e.target.checked })} />
          {t("workflow.multiplePeople")}
        </label>
      )}
      <DefaultEditor field={field} onChange={(value) => onChange({ default: value })} />
    </li>
  );
}

/** The field's default: what fits its type (literal, today, the next weekday, me). */
function DefaultEditor({ field, onChange }: { field: WorkflowField; onChange: (value: FieldDefault | null) => void }) {
  const spec = field.default ?? null;
  const wrap = (children: React.ReactNode) => <div className="flex flex-wrap items-center gap-2 pl-7 text-xs"><span className="text-muted">{t("workflow.default")}</span>{children}</div>;
  switch (field.type) {
    case "user":
      return wrap(
        <label className="flex items-center gap-1">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={spec?.kind === "me"} onChange={(e) => onChange(e.target.checked ? { kind: "me" } : null)} />
          {t("workflow.defaultMe")}
        </label>,
      );
    case "checkbox":
      return wrap(
        <label className="flex items-center gap-1">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={spec?.value === true} onChange={(e) => onChange(e.target.checked ? { kind: "literal", value: true } : null)} />
          {t("workflow.on")}
        </label>,
      );
    case "select":
      return wrap(
        <select aria-label={t("workflow.defaultOption")} className={cn(SELECT, "py-1 text-xs")} value={typeof spec?.value === "string" ? spec.value : ""} onChange={(e) => onChange(e.target.value ? { kind: "literal", value: e.target.value } : null)}>
          <option value="">{t("workflow.none")}</option>
          {(field.options ?? []).filter((o) => o.trim()).map((o) => <option key={o} value={o.trim()}>{o.trim()}</option>)}
        </select>,
      );
    case "date":
    case "datetime": {
      const kind = spec?.kind ?? "";
      return wrap(
        <>
          <select
            aria-label={t("workflow.defaultDate")}
            className={cn(SELECT, "py-1 text-xs")}
            value={kind}
            onChange={(e) => {
              const next = e.target.value;
              const time = field.type === "datetime" ? (spec?.time ?? "09:00") : null;
              if (next === "today") onChange({ kind: "today", time });
              else if (next === "next_weekday") onChange({ kind: "next_weekday", weekday: spec?.weekday ?? 0, time });
              else onChange(null);
            }}
          >
            <option value="">{t("workflow.none")}</option>
            <option value="today">{t("workflow.today")}</option>
            <option value="next_weekday">{t("workflow.nextWeekday")}</option>
          </select>
          {kind === "next_weekday" && (
            <select aria-label={t("settings.quiet.weekdays")} className={cn(SELECT, "py-1 text-xs")} value={spec?.weekday ?? 0} onChange={(e) => onChange({ ...spec!, weekday: Number(e.target.value) })}>
              {WEEKDAYS_JA.map((label, day) => <option key={label} value={day}>{weekdayName(day, "long")}</option>)}
            </select>
          )}
          {field.type === "datetime" && kind && (
            <Input type="time" aria-label={t("workflow.defaultTime")} className="h-7 w-28 text-xs" value={spec?.time ?? "09:00"} onChange={(e) => onChange({ ...spec!, time: e.target.value || "09:00" })} />
          )}
        </>,
      );
    }
    case "time":
      return wrap(<Input type="time" aria-label={t("workflow.defaultTime")} className="h-7 w-28 text-xs" value={typeof spec?.value === "string" ? spec.value : ""} onChange={(e) => onChange(e.target.value ? { kind: "literal", value: e.target.value } : null)} />);
    default:
      return wrap(<Input aria-label={t("workflow.defaultText")} className="h-7 min-w-0 flex-1 text-xs" value={typeof spec?.value === "string" ? spec.value : ""} maxLength={field.type === "text" ? MAX_TEXT : MAX_TEXTAREA} onChange={(e) => onChange(e.target.value ? { kind: "literal", value: e.target.value } : null)} />);
  }
}
