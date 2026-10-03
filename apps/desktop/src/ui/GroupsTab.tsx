import { Pencil, Trash2, Users, UsersRound } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { GroupOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import { UserPicker } from "./Dialogs";
import { Badge, Button, Field, Input, Modal } from "./primitives";

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
        <span className="text-sm text-muted">本文の @グループ名 でメンバー全員に知らせます。{groups.length > 0 && ` ${groups.length} 件`}</span>
        <Button size="sm" onClick={() => setEditing("new")}>
          <UsersRound size={14} /> グループを作成
        </Button>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {groups.map((group) => (
          <li key={group.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Users size={16} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">@{group.name}</span>
                <Badge>{group.member_ids.length} 人</Badge>
                {group.managed && <Badge tone="accent">名簿から自動</Badge>}
              </div>
              <div className="truncate text-[11px] text-muted">
                {group.description ? `${group.description} · ` : ""}
                {group.member_ids.map((id) => store.users.get(id)?.display_name ?? "?").join(", ") || "メンバーなし"}
              </div>
            </div>
            {/* M23: a managed group follows the lab roster (the server refuses edits with 409 group_managed). */}
            {group.managed ? (
              <span className="shrink-0 text-[11px] text-muted">「名簿」タブで変更</span>
            ) : (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(group)}>
                  <Pencil size={14} /> 編集
                </Button>
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setDeleting(group)}>
                  <Trash2 size={14} /> 削除
                </Button>
              </>
            )}
          </li>
        ))}
        {groups.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">グループはまだありません</li>}
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
        <Modal onClose={() => setDeleting(null)} title={`@${deleting.name} を削除しますか？`} className="w-[420px]">
          <p className="mt-3 text-sm text-muted">以後 @{deleting.name} は誰にも通知されません。過去のメッセージの表示は「@グループ」になります。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = deleting; void run(async () => { await controller.api!.adminDeleteGroup(target.id); store.applyGroup(target, true); }).then((ok) => { if (ok) setDeleting(null); }); }}>
              削除する
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
    <Modal onClose={onClose} title={group ? `@${group.name} を編集` : "グループを作成"} className="w-[520px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="名前 (2〜32 文字、a-z 0-9 . _ -)">
            <Input value={name} pattern="[a-z0-9][a-z0-9._-]{1,31}" required autoFocus onChange={(e) => setName(e.target.value.toLowerCase())} />
          </Field>
          <Field label="説明 (任意)">
            <Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <Field label={`メンバー (${memberIds.length} 人)`}>
          <Input value={filter} placeholder="名前で絞り込み" onChange={(e) => setFilter(e.target.value)} />
        </Field>
        <UserPicker users={shown} selected={memberIds} onToggle={(id) => setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))} empty="該当するユーザーがいません" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>キャンセル</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>{group ? "保存" : "作成"}</Button>
        </div>
      </form>
    </Modal>
  );
}
