import { MessageCircle, Search } from "lucide-react";
import { useState } from "react";

import type { UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { Badge, Button, Input, Modal } from "./primitives";
import { activeStatus } from "./users";

/** 「メンバー」(M13g): everyone in the workspace, with presence, title and status; a DM is one click away. */
export function DirectoryDialog({ controller, onClose, onOpen }: { controller: AppController; onClose: () => void; onOpen: (channelId: string) => void }) {
  const store = controller.store;
  const me = store.me?.id;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const people = [...store.users.values()]
    .filter((u) => !u.deactivated_at)
    .filter((u) => !q || u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q) || (u.title ?? "").toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name, "ja"));

  function rank(user: UserPublic): number {
    if (user.role === "bot") return 3;
    const presence = store.presenceOf(user.id);
    return presence === "online" ? 0 : presence === "away" ? 1 : 2;
  }

  const dm = async (userId: string) => {
    const id = await controller.openDmWith(userId);
    if (id) {
      onOpen(id);
      onClose();
    }
  };

  return (
    <Modal onClose={onClose} title="メンバー" description={`${people.length} 人`} className="w-[560px]">
      <div className="mt-3 space-y-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前・ユーザー名・肩書で検索" className="pl-8" autoFocus />
        </div>
        <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {people.map((user) => {
            const status = activeStatus(user);
            const presence = store.presenceOf(user.id);
            return (
              <li key={user.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Avatar id={user.id} name={user.display_name} size={34} presence={user.role === "bot" ? undefined : presence} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{user.display_name}</span>
                    <span className="truncate text-xs text-muted">@{user.username}</span>
                    {user.role === "admin" && <Badge tone="accent">管理者</Badge>}
                    {user.role === "guest" && <Badge>ゲスト</Badge>}
                    {user.role === "bot" && <Badge>BOT</Badge>}
                    {user.dnd_until && <span title="通知を一時停止中">🔕</span>}
                    {user.id === me && <span className="text-xs text-muted">自分</span>}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {[user.title, status ? `${status.emoji} ${status.text}`.trim() : null].filter(Boolean).join(" · ") || (user.role === "bot" ? "受信 Webhook" : presence === "online" ? "オンライン" : presence === "away" ? "離席中" : "オフライン")}
                  </div>
                </div>
                {user.id !== me && user.role !== "bot" && (
                  <Button size="sm" variant="ghost" onClick={() => void dm(user.id)}>
                    <MessageCircle size={14} /> DM
                  </Button>
                )}
              </li>
            );
          })}
          {people.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">該当するメンバーがいません</li>}
        </ul>
      </div>
    </Modal>
  );
}
