import { Pencil, UserMinus, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { Affiliation, FacultyRank, Grade, LabProfileOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { Badge, Button, Field, Input, Modal } from "./primitives";
import { AFFILIATIONS, compareByRoster, GRADES, RANKS, rosterLabel, supervisorLabel } from "./roster";
import { RolloverView } from "./RolloverView";
import { t } from "../i18n";

const SELECT = "h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm";

/**
 * Administration → 名簿 (M23): who is faculty, which grade a student is in, the supervisor. The managed groups (@b4 @m1
 * @m2 @d @faculty @students @alumni) follow on the server; people edit their own research topic in 設定.
 */
export function RosterTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const people = [...store.users.values()].filter((u) => !u.deactivated_at && u.role !== "bot").sort((a, b) => compareByRoster(a, b, store.roster));
  const [editing, setEditing] = useState<UserPublic | null>(null);
  const [removing, setRemoving] = useState<UserPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"roster" | "rollover">("roster");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      return true;
    } catch (error) {
      controller.setError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // M142: the yearly rollover changes roles: administrators only (lab.rollover); a manager sees the roster alone.
  const switcher = !controller.can("lab.rollover") ? null : (
    <div className="flex gap-1" role="group" aria-label={t("roster.view")}>
      {([["roster", t("admin.tab.roster")], ["rollover", t("roster.rollover")]] as const).map(([value, label]) => (
        <Button key={value} size="sm" variant={view === value ? "primary" : "secondary"} aria-pressed={view === value} onClick={() => setView(value)}>
          {label}
        </Button>
      ))}
    </div>
  );
  if (view === "rollover") {
    return (
      <div className="mt-4 space-y-3">
        {switcher}
        <RolloverView controller={controller} />
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {switcher}
      <p className="text-sm text-muted">
        {t("roster.note")}
      </p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {people.map((user) => {
          const line = store.roster.get(user.id);
          return (
            <li key={user.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Avatar id={user.id} name={user.display_name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{user.display_name}</span>
                  <span className="truncate text-xs text-muted">@{user.username}</span>
                  {line ? <Badge tone="accent">{rosterLabel(line)}</Badge> : <Badge>{t("roster.notInRoster")}</Badge>}
                </div>
                {line && (line.supervisor_id || line.research_topic) && (
                  <div className="truncate text-[11px] text-muted">
                    {[supervisorLabel(line, store.users), line.research_topic].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(user)}>
                {line ? <><Pencil size={14} /> {t("canvas.edit")}</> : <><UserPlus size={14} /> {t("roster.add")}</>}
              </Button>
              {line && (
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setRemoving(user)} title={t("roster.removeTitle")}>
                  <UserMinus size={14} />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {editing && (
        <RosterEditor
          controller={controller}
          user={editing}
          line={store.roster.get(editing.id)}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(body) =>
            void run(async () => {
              store.applyRoster(editing.id, await controller.api!.adminPutRosterLine(editing.id, body)); // roster.updated confirms everywhere
            }).then((ok) => { if (ok) setEditing(null); })
          }
        />
      )}
      {removing && (
        <Modal onClose={() => setRemoving(null)} title={t("roster.removeQuestion", { name: removing.display_name })} className="w-[420px]">
          <p className="mt-2 text-sm text-muted">{t("roster.removeNote")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await controller.api!.adminDeleteRosterLine(removing.id);
                  store.applyRoster(removing.id, null);
                }).then((ok) => { if (ok) setRemoving(null); })
              }
            >
              {t("settings.workspaces.remove")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface RosterForm {
  affiliation: Affiliation;
  rank: FacultyRank | null;
  grade: Grade | null;
  supervisor_id: string | null;
  research_topic: string | null;
  reading: string | null;
}

function RosterEditor({ controller, user, line, busy, onClose, onSave }: {
  controller: AppController;
  user: UserPublic;
  line: LabProfileOut | undefined;
  busy: boolean;
  onClose: () => void;
  onSave: (body: RosterForm) => void;
}) {
  const store = controller.store;
  const [affiliation, setAffiliation] = useState<Affiliation>(line?.affiliation ?? "student");
  const [rank, setRank] = useState<FacultyRank | "">(line?.rank ?? "");
  const [grade, setGrade] = useState<Grade | "">(line?.grade ?? "");
  const [supervisor, setSupervisor] = useState(line?.supervisor_id ?? "");
  const [topic, setTopic] = useState(line?.research_topic ?? "");
  const [reading, setReading] = useState(line?.reading ?? "");
  // The server takes faculty on the roster only (422 invalid_supervisor).
  const faculty = [...store.roster.values()].filter((p) => p.affiliation === "faculty" && p.user_id !== user.id).map((p) => store.users.get(p.user_id)).filter((u): u is UserPublic => !!u);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      affiliation,
      rank: affiliation === "faculty" && rank ? rank : null,
      grade: affiliation === "student" && grade ? grade : null,
      supervisor_id: supervisor || null,
      research_topic: topic.trim() || null,
      reading: reading.trim() || null,
    });
  };

  return (
    <Modal onClose={onClose} title={t("roster.of", { name: user.display_name })} className="w-[480px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label={t("roster.affiliation")}>
          <select value={affiliation} onChange={(e) => setAffiliation(e.target.value as Affiliation)} className={SELECT}>
            {AFFILIATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        {affiliation === "faculty" && (
          <Field label={t("roster.rank")}>
            <select value={rank} onChange={(e) => setRank(e.target.value as FacultyRank | "")} className={SELECT}>
              <option value="">{t("invites.unspecified")}</option>
              {RANKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        )}
        {affiliation === "student" && (
          <Field label={t("roster.grade")}>
            <select value={grade} onChange={(e) => setGrade(e.target.value as Grade | "")} className={SELECT}>
              <option value="">{t("invites.unspecified")}</option>
              {[...GRADES].reverse().map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </Field>
        )}
        <Field label={t("roster.supervisor")} hint={faculty.length === 0 ? t("invites.supervisorHint") : undefined}>
          <select value={supervisor} onChange={(e) => setSupervisor(e.target.value)} className={SELECT} disabled={faculty.length === 0}>
            <option value="">{t("workflow.none")}</option>
            {faculty.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
        </Field>
        <Field label={t("roster.topic")}>
          <Input value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <Field label={t("roster.reading")}>
          <Input value={reading} maxLength={80} placeholder={t("settings.profile.readingPlaceholder")} onChange={(e) => setReading(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy}>{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
