/**
 * Who may do what with a conversation's canvases (CANVAS.md §4.7), as the server decides it
 * (server/app/modules/canvases/service.py). The screen only hides what would be refused; the server checks every call.
 */
import type { CanvasMeta } from "../api/types";
import type { ChannelState } from "../sync/types";

export interface CanvasActor {
  id: string | null;
  isAdmin: boolean;
  isGuest: boolean;
}

export interface CanvasRights {
  /** Make a canvas in the conversation. */
  create: boolean;
  /** Change the body (the editor). */
  edit: boolean;
  /** Tick tasks (everyone but guests, whatever edit_policy says; in a DM its members). */
  tick: boolean;
  /** Title, edit_policy, the conversation's tab. */
  manage: boolean;
  /** To the trash and back. */
  trash: boolean;
}

const NONE: CanvasRights = { create: false, edit: false, tick: false, manage: false, trash: false };

export function isDmConversation(channel: Pick<ChannelState, "type">): boolean {
  return channel.type === "dm" || channel.type === "group_dm";
}

/** Rights in the conversation for a canvas (null: only whether one can be made). */
export function canvasRights(channel: ChannelState, actor: CanvasActor, canvas: Pick<CanvasMeta, "created_by" | "edit_policy"> | null): CanvasRights {
  if (!channel.isMember || channel.archived) return NONE; // an archived conversation's canvases are read only
  const dm = isDmConversation(channel);
  if (dm) {
    const creator = canvas !== null && canvas.created_by === actor.id;
    return { create: true, edit: true, tick: true, manage: true, trash: canvas === null ? false : creator };
  }
  const manager = actor.isAdmin || channel.membership?.role === "owner";
  const create = !actor.isGuest && (channel.posting_policy !== "owners" || manager);
  if (!canvas) return { ...NONE, create };
  const creator = canvas.created_by === actor.id;
  const edit = canvas.edit_policy === "owners" ? !actor.isGuest && (creator || manager) : create;
  const manage = !actor.isGuest && (creator || manager);
  return { create, edit, tick: edit || !actor.isGuest, manage, trash: manage };
}
