import { ContextMenu } from "radix-ui";
import { ChevronDown, LogOut, Plus } from "lucide-react";
import { useState } from "react";

import type { AppController } from "../state/app";
import { hostLabel, type WorkspaceEntry, workspaceColor, workspaceInitials } from "../state/workspaces";
import { Button, cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, modKey } from "./primitives";

const MENU = "rx-popover z-50 min-w-48 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft";

/** M16c: the workspaces down the left edge (Slack): number / dot for unread, ⌘1 … ⌘9, + to add (WORKSPACES.md §5). */
export function WorkspaceRail({ controller }: { controller: AppController }) {
  const [leaving, setLeaving] = useState<WorkspaceEntry | null>(null);
  return (
    <nav aria-label="ワークスペース" className="flex w-[68px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-r border-black/20 bg-[color-mix(in_srgb,var(--sidebar)_78%,black)] py-3">
      {controller.workspaces.map((entry, index) => (
        <WorkspaceTile key={entry.serverUrl} controller={controller} entry={entry} index={index} onLeave={() => setLeaving(entry)} />
      ))}
      <button
        type="button"
        title="ワークスペースを追加"
        aria-label="ワークスペースを追加"
        onClick={() => controller.beginAddWorkspace()}
        className={cn("flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-white/30 text-white/70 transition-colors hover:border-white/60 hover:text-white", controller.addingWorkspace && "border-solid border-white bg-white/10 text-white")}
      >
        <Plus size={18} />
      </button>
      {leaving && (
        <Modal title={`${leaving.name} からサインアウトしますか？`} description={`${leaving.username} @ ${hostLabel(leaving.serverUrl)}`} onClose={() => setLeaving(null)}>
          <p className="mt-3 text-sm text-muted">この端末に保存したこのワークスペースのメッセージと下書きを消し、一覧から外します。サーバ上のデータは消えません。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLeaving(null)}>キャンセル</Button>
            <Button variant="danger" onClick={() => { const target = leaving; setLeaving(null); void controller.signOutWorkspace(target.serverUrl); }}>
              サインアウト
            </Button>
          </div>
        </Modal>
      )}
    </nav>
  );
}

function WorkspaceTile({ controller, entry, index, onLeave }: { controller: AppController; entry: WorkspaceEntry; index: number; onLeave: () => void }) {
  const active = entry.serverUrl === controller.activeServer && !controller.addingWorkspace;
  const signedIn = controller.isSignedIn(entry.serverUrl);
  const { badge, unread } = active ? { badge: 0, unread: false } : controller.workspaceUnread(entry.serverUrl);
  const shortcut = index < 9 ? ` (${modKey()}+${index + 1})` : "";
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="relative flex w-full justify-center">
          {/* Slack's marker: a bar on the left edge for the open workspace, a short one for unread. */}
          <span className={cn("absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-white transition-all", active ? "h-8" : unread ? "h-2" : "h-0")} />
          <button
            type="button"
            title={`${entry.name}${shortcut}${signedIn || active ? "" : " — サインインが必要です"}`}
            aria-label={entry.name}
            aria-current={active ? "true" : undefined}
            onClick={() => void controller.switchWorkspace(entry.serverUrl)}
            className={cn(
              "relative flex h-10 w-10 items-center justify-center rounded-xl text-[15px] font-bold text-white shadow-sm transition-all",
              active ? "ring-2 ring-white ring-offset-2 ring-offset-[color-mix(in_srgb,var(--sidebar)_78%,black)]" : "opacity-85 hover:opacity-100",
              !signedIn && !active && "opacity-45 grayscale",
            )}
            style={{ background: workspaceColor(entry.workspaceId ?? entry.serverUrl) }}
          >
            {workspaceInitials(entry.name)}
            {badge > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-[color-mix(in_srgb,var(--sidebar)_78%,black)]">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU}>
          <ContextMenu.Label className="px-2.5 py-1 text-xs text-muted">
            {entry.username} @ {hostLabel(entry.serverUrl)}
          </ContextMenu.Label>
          <ContextMenu.Item className={ITEM} onSelect={() => void controller.switchWorkspace(entry.serverUrl)}>開く</ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Item className={cn(ITEM, "text-danger")} onSelect={signedIn || active ? onLeave : () => void controller.signOutWorkspace(entry.serverUrl)}>
            {signedIn || active ? "サインアウト…" : "一覧から外す"}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The workspace name over the sidebar: who is signed in where, 「ワークスペースを追加…」 and ログアウト. */
export function WorkspaceMenu({ controller }: { controller: AppController }) {
  const entry = controller.activeEntry;
  const name = controller.workspaceName;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm font-semibold text-white hover:bg-white/10">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white" style={{ background: workspaceColor(entry?.workspaceId ?? entry?.serverUrl ?? name) }}>
            {workspaceInitials(name)}
          </span>
          <span className="truncate">{name}</span>
          <ChevronDown size={14} className="shrink-0 opacity-70" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="min-w-60">
        {entry && <div className="px-2.5 pb-1 pt-1.5 text-xs text-muted">{entry.username} @ {hostLabel(entry.serverUrl)}</div>}
        {controller.multiWorkspace && (
          <MenuItem onSelect={() => controller.beginAddWorkspace()}>
            <Plus size={15} /> ワークスペースを追加…
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem className="text-danger" onSelect={() => void controller.logout()}>
          <LogOut size={15} /> {controller.workspaces.length > 1 ? `${name} からログアウト` : "ログアウト"}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
