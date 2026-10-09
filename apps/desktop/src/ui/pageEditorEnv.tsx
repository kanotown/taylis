/**
 * M153a (WIKI.md §22.7, §30.3): what the 見たまま page editor (PageEditor.tsx) needs from the app around it, as one
 * small interface, so the same editor runs on Desktop / Web (ui/pageEditorDesktopEnv.tsx: the controller and the
 * store) and inside the phones' WebView (src/mobileEditor/bridgeEnv.tsx: the native bridge). PageEditor.tsx imports
 * nothing of the app's state, API or router; everything it draws or asks for goes through here.
 *
 * This module is types only (no React, no app imports): the mobile bundle must not pull the app in.
 */
import type { ReactNode } from "react";

import type { GroupOut, UserPublic } from "../api/types";
import type { EmojiEntry } from "./emojiData";
import type { PageEditorHost } from "./pageEditorSchema";

/** The native toolbar's buttons (the bridge's `command`): the list lives with the bridge contract. */
export type { EditorCommand } from "../../../shared/mobile-editor/src/bridge";

/** The people `@` offers (mentions.ts reads them) and the names `<@id>` chips show. */
export interface PageEditorPeople {
  users: ReadonlyMap<string, UserPublic>;
  groups: ReadonlyMap<string, GroupOut>;
  /** The AI agents' bot users once known (mentions.ts aiBotIds), else null. */
  aiBotIds: ReadonlySet<string> | null;
}

export interface PageEditorEnv {
  /** Re-renders the editor when the people, pages or emoji it offers change (phones: when native answers). */
  subscribe(listener: () => void): () => void;
  version(): number;
  /** `:name:` is a custom emoji of this workspace (the renderer draws it; the editor keeps it as an atom). */
  isCustomEmoji(name: string): boolean;
  people(): PageEditorPeople;
  /** Phones: `@` opened or its query changed — native may send (more) people. */
  onMentionQuery?(query: string): void;
  /** What the atoms draw (the host's render minus math, which the editor draws itself with KaTeX). */
  render: Omit<PageEditorHost["render"], "math" | "inlineMath"> & {
    /** A page's icon in the `[[` / `@` / ⌘K rows. */
    pageIcon(icon: string | null | undefined, size: number): ReactNode;
    /** The emoji picker for a callout's icon. */
    emojiPicker(onPick: (entry: EmojiEntry) => void): ReactNode;
  };
  copyText(text: string): void;
  showError(error: unknown): void;
  /** The error for more images than a page may hold. */
  imageLimitError(): unknown;
  /** A picked, pasted or dropped image: uploaded, its attachment's id returned (null: refused, the error shown). */
  uploadImage(file: File): Promise<{ id: string } | null>;
  /** Phones: the picture is chosen and uploaded natively (an insertImage follows); the file input is not used. */
  pickImage?(): void;
  /** Where the formatting row goes: above the body (Desktop) or fixed at the bottom, above the keyboard (phones). */
  toolbar: "top" | "bottom";
  readOnly(): boolean;
  /** False: the editor does not take the focus when it opens (a phone's keyboard comes with the bridge's `focus`). */
  autoFocus?: boolean;
}

/**
 * The save loop as the editor sees it: the body it holds, bumped when it changed from outside (a merge, someone else's
 * version), the edits written back when typing pauses. Desktop / Web: sync/canvasSave.ts CanvasSaver (its own state
 * machine, versions, conflicts). Phones: the bridge's sink (native's CanvasSaver does the saving; WIKI.md §30.3).
 */
export interface PageEditorSink {
  text: string;
  textRevision: number;
  /**
   * Whether the editor can take a new text now (set by the editor: not while an IME composition is open or an edit
   * waits to be written). When it cannot, the new body waits: the next save carries this text on the version that holds
   * it, and the server merges again.
   */
  canReplace: () => boolean;
  subscribe(listener: () => void): () => void;
  edit(text: string): void;
  /** Save now (leaving, ⌘S, the window hiding). */
  flush(): Promise<void> | void;
  /** An IME composition ended (or a refused replacement waited for nothing): a body held back can go in now. */
  compositionEnded(): void;
}
