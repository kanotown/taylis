/** The first http(s) link in a body, outside code (M11g); null when there is none. */
export function firstLink(body: string): string | null {
  const withoutCode = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const match = /https?:\/\/[^\s<>)\]]+/.exec(withoutCode);
  if (!match) return null;
  return match[0].replace(/[.,!?;:。、」』）]+$/, "");
}
