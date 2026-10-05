import { Pencil, Trash2, Users, UsersRound } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { GroupOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import { UserPicker } from "./Dialogs";
import { Badge, Button, Field, Input, Modal } from "./primitives";
import { t } from "../i18n";

/** Administration → グループ (M12k): named sets of members that `@name` notifies. */
export function GroupsTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const groups = [...store.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  const people = [...store.users.values()].filter((u) => !u.deactivated_at).sort((a, b) => a.username.localeCompare(b.username));
  const [editing, setEditing] = useState<GroupOut | "new" | null>(null);
  const [deleting, setDeleting] = useState<GroupOut | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{t("groups.intro")}{groups.length > 0 && ` ${t("common.count", { count: groups.length })}`}</span>
        <Button size="sm" onClick={() => setEditing("new")}>
          <UsersRound size={14} /> {t("groups.create")}
        </Button>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {groups.map((group) => (
          <li key={group.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Users size={16} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">@{group.name}</span>
                <Badge>{t("common.people", { count: group.member_ids.length })}</Badge>
                {group.managed && <Badge tone="accent">{t("groups.managed")}</Badge>}
              </div>
              <div className="truncate text-[11px] text-muted">
                {group.description ? `${group.description} · ` : ""}
                {group.member_ids.map((id) => store.users.get(id)?.display_name ?? "?").join(", ") || t("groups.noMembers")}
              </div>
            </div>
            {/* M23: a managed group follows the lab roster (the server refuses edits with 409 group_managed). */}
            {group.managed ? (
              <span className="shrink-0 text-[11px] text-muted">{t("groups.changeInRoster")}</span>
            ) : (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(group)}>
                  <Pencil size={14} /> {t("canvas.edit")}
                </Button>
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setDeleting(group)}>
                  <Trash2 size={14} /> {t("common.delete")}
                </Button>
              </>
            )}
          </li>
        ))}
        {groups.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("groups.none")}</li>}
      </ul>
      {editing && (
        <GroupEditor
          group={editing === "new" ? null : editing}
          people={people}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(form) =>
            void run(async () => {
              const api = controller.api!;
              const saved = editing === "new"
                ? await api.adminCreateGroup({ name: form.name, description: form.description || null, member_ids: form.memberIds })
                : await api.adminUpdateGroup(editing.id, { name: form.name, description: form.description || null, member_ids: form.memberIds });
              store.applyGroup(saved, false); // group.updated confirms on every device
            }).then((ok) => { if (ok) setEditing(null); })
          }
        />
      )}
      {deleting && (
        <Modal onClose={() => setDeleting(null)} title={t("groups.deleteTitle", { name: deleting.name })} className="w-[420px]">
          <p className="mt-3 text-sm text-muted">{t("groups.deleteNote", { name: deleting.name })}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = deleting; void run(async () => { await controller.api!.adminDeleteGroup(target.id); store.applyGroup(target, true); }).then((ok) => { if (ok) setDeleting(null); }); }}>
              {t("common.deleteConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GroupEditor({ group, people, busy, onClose, onSave }: {
  group: GroupOut | null;
  people: UserPublic[];
  busy: boolean;
  onClose: () => void;
  onSave: (form: { name: string; description: string; memberIds: string[] }) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(group?.member_ids ?? []);
  const [filter, setFilter] = useState("");
  const shown = people.filter((u) => !filter || u.username.includes(filter.toLowerCase()) || u.display_name.toLowerCase().includes(filter.toLowerCase()));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ name: name.trim().toLowerCase(), description: description.trim(), memberIds });
  };

  return (
    <Modal onClose={onClose} title={group ? t("groups.editTitle", { name: group.name }) : t("groups.create")} className="w-[520px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("groups.nameLabel")}>
            <Input value={name} pattern="[a-z0-9][a-z0-9._-]{1,31}" required autoFocus onChange={(e) => setName(e.target.value.toLowerCase())} />
          </Field>
          <Field label={t("canvasTemplates.descriptionOptional")}>
            <Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <Field label={t("groups.membersLabel", { count: memberIds.length })}>
          <Input value={filter} placeholder={t("tasks.dialog.filterPlaceholder")} onChange={(e) => setFilter(e.target.value)} />
        </Field>
        <UserPicker users={shown} selected={memberIds} onToggle={(id) => setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))} empty={t("admin.users.noMatch")} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>{group ? t("common.save") : t("common.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}
