/**
 * M142 (docs/ROLES.md): workspace roles and capabilities on the client. The server sends my capabilities in `me`
 * (`UserMe.capabilities`, app/core/roles.py is the table); screens are gated by those, never by the role name, so a new
 * role needs no client change. The server checks every call anyway; this is only what to show.
 */

import type { MessageKey } from "../i18n";

export type Capability =
  | "users.view"
  | "users.view_private"
  | "users.edit_profile"
  | "users.manage"
  | "invites.manage"
  | "roster.manage"
  | "lab.rollover"
  | "channels.manage"
  | "channels.manage_any"
  | "channels.make_public"
  | "channels.moderate"
  | "emoji.manage"
  | "templates.manage"
  | "attendance.manage"
  | "attendance.configure"
  | "reservations.manage"
  | "reports.manage"
  | "reports.read_private"
  | "workspace.settings"
  | "groups.manage"
  | "integrations.manage"
  | "ai.manage"
  | "analytics.view"
  | "docs.admin";

type Me = { role: string; capabilities?: string[] | null } | null | undefined;

/** My capabilities. A server before M142 sends none: an administrator may do everything there, anyone else nothing. */
export function capabilitiesOf(me: Me): ReadonlySet<string> {
  if (!me) return new Set();
  if (Array.isArray(me.capabilities)) return new Set(me.capabilities);
  return me.role === "admin" ? ALL : new Set();
}

const ALL: ReadonlySet<string> = new Set<Capability>([
  "users.view", "users.view_private", "users.edit_profile", "users.manage", "invites.manage", "roster.manage", "lab.rollover",
  "channels.manage", "channels.manage_any", "channels.make_public", "channels.moderate", "emoji.manage", "templates.manage",
  "attendance.manage", "attendance.configure", "reservations.manage", "reports.manage", "reports.read_private",
  "workspace.settings", "groups.manage", "integrations.manage", "ai.manage", "analytics.view", "docs.admin",
]);

export function hasCapability(me: Me, capability: Capability): boolean {
  return capabilitiesOf(me).has(capability);
}

export type AdminTab = "users" | "analytics" | "reports" | "roster" | "groups" | "invites" | "webhooks" | "workflows" | "ai" | "workspace" | "channels" | "emoji" | "canvas-templates" | "docs" | "attendance";

/** Which capability opens each tab of 「管理」 (docs/ROLES.md §7); the workspace tab also for the default channels. */
const TAB_NEEDS: Record<AdminTab, Capability[]> = {
  users: ["users.view"],
  analytics: ["analytics.view"],
  reports: ["reports.manage"],
  roster: ["roster.manage"],
  groups: ["groups.manage"],
  invites: ["invites.manage"],
  webhooks: ["integrations.manage"],
  attendance: ["attendance.manage"],
  workflows: ["channels.moderate"],
  ai: ["ai.manage"],
  workspace: ["workspace.settings", "channels.manage"],
  channels: ["channels.manage"],
  emoji: ["emoji.manage"],
  "canvas-templates": ["templates.manage"],
  docs: ["docs.admin"],
};

export const ADMIN_TABS = Object.keys(TAB_NEEDS) as AdminTab[];

export function adminTabAllowed(tab: AdminTab, can: (capability: Capability) => boolean): boolean {
  return TAB_NEEDS[tab].some(can);
}

/** Whether 「管理」 shows at all: any tab is mine. */
export function canAdminister(can: (capability: Capability) => boolean): boolean {
  return ADMIN_TABS.some((tab) => adminTabAllowed(tab, can));
}

/** The roles an account may be given in 「管理」, in menu order; managers may give member and guest only (invites). */
export function assignableRoles(can: (capability: Capability) => boolean): Array<"admin" | "manager" | "member" | "guest"> {
  return can("users.manage") ? ["member", "manager", "admin", "guest"] : ["member", "guest"];
}

/** The label of a role, for badges and lists; null for a plain member (and roles this build does not know). */
export function roleLabelKey(role: string): MessageKey | null {
  switch (role) {
    case "admin":
      return "admin.users.role.admin";
    case "manager":
      return "admin.users.role.manager";
    case "guest":
      return "dialogs.guest";
    default:
      return null;
  }
}

/**
 * Whether I may rename, archive or remove members of a channel without owning it (docs/ROLES.md §2 channels.manage):
 * public channels and private ones I belong to; channels.manage_any (administrators) also private ones I am not in.
 */
export function canManageChannelByRight(channel: { type: string; isMember: boolean }, can: (capability: Capability) => boolean): boolean {
  if (channel.type === "dm" || channel.type === "group_dm") return false;
  if (!can("channels.manage")) return false;
  return channel.type === "public" || channel.isMember || can("channels.manage_any");
}
