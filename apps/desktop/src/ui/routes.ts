/** The browser build's entry URLs (M12j): a message permalink or an invite link opened in a browser. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

export type EntryRoute = { kind: "message"; id: string } | { kind: "invite"; token: string };

/** What `location.pathname` asks for; null for the app root or anything unknown. */
export function parseEntryPath(pathname: string): EntryRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts[0] === "m" && UUID.test(parts[1]!)) return { kind: "message", id: parts[1]!.toLowerCase() };
  if (parts[0] === "invite" && TOKEN.test(parts[1]!)) return { kind: "invite", token: parts[1]! };
  return null;
}
