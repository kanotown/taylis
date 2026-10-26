/** The browser build's entry URLs (M12j): a message permalink, a canvas link (M44), a Docs page (M121), a calendar event (CALENDAR.md §11), a drive item (M165), an equipment item's label (M173, `/eq/`) or an invite link opened in a browser. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

export type EntryRoute = { kind: "message"; id: string } | { kind: "canvas"; id: string } | { kind: "page"; id: string } | { kind: "event"; id: string } | { kind: "drive"; id: string } | { kind: "equipment"; id: string } | { kind: "invite"; token: string };

/** What `location.pathname` asks for; null for the app root or anything unknown. */
export function parseEntryPath(pathname: string): EntryRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts[0] === "m" && UUID.test(parts[1]!)) return { kind: "message", id: parts[1]!.toLowerCase() };
  if (parts[0] === "c" && UUID.test(parts[1]!)) return { kind: "canvas", id: parts[1]!.toLowerCase() };
  if (parts[0] === "p" && UUID.test(parts[1]!)) return { kind: "page", id: parts[1]!.toLowerCase() };
  if (parts[0] === "e" && UUID.test(parts[1]!)) return { kind: "event", id: parts[1]!.toLowerCase() };
  // M165 (docs/DRIVE.md §13.1): a drive file or folder.
  if (parts[0] === "d" && UUID.test(parts[1]!)) return { kind: "drive", id: parts[1]!.toLowerCase() };
  // M173 (docs/LENDING.md §13.5): an equipment item, the QR code on its label (`/e/` is a calendar event's).
  if (parts[0] === "eq" && UUID.test(parts[1]!)) return { kind: "equipment", id: parts[1]!.toLowerCase() };
  if (parts[0] === "invite" && TOKEN.test(parts[1]!)) return { kind: "invite", token: parts[1]! };
  return null;
}
