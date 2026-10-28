/**
 * A channel's topic with its links (2026-10-28, as Mattermost's channel header): `[text](https://…)`, bare http(s) URLs
 * and `[text](mailto:…)` are links, **bold**, _italic_, ~~strike~~ and `code` keep their look, all on one line (the
 * header truncates it with an ellipsis). The topic is still edited as plain text. Only http(s) and mailto are ever
 * links (the message tokenizer links nothing else, so `[x](javascript:…)` stays text); a link on this server
 * (`/m/`, `/c/`, `/p/`, `/e/`, `/d/`, `/eq/`) opens in the app, any other one in the system browser on Tauri (a new tab on
 * the web), as in messages. Mentions read as names; math stays its text. No cards or chips: they do not fit one line.
 */
import type { MouseEvent, ReactNode } from "react";

import type { AppController } from "../state/app";
import { tokenizeInline, type Token } from "./markdown";
import { parseCanvasLink, parseDriveLink, parseEquipmentLink, parseEventLink, parsePageLink, parsePermalink } from "./permalink";
import { openExternalLink } from "../platform/external";
import { cn } from "./primitives";

export type TopicToken =
  | { kind: "text" | "bold" | "italic" | "strike" | "code"; text: string }
  | { kind: "link"; url: string; label?: string };

const MAILTO = /\[([^\]\n]+)\]\((mailto:[^\s()<>"]+@[^\s()<>"]+)\)/g;

/** The topic's tokens (apps/desktop/tests/topicText.test.tsx): the message dialect's inline tokens, narrowed to these. */
export function topicTokens(topic: string, nameOf: (userId: string) => string | null = () => null): TopicToken[] {
  const out: TopicToken[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += value;
    else out.push({ kind: "text", text: value });
  };
  const mailtoSplit = (value: string) => {
    let last = 0;
    MAILTO.lastIndex = 0;
    for (let match = MAILTO.exec(value); match; match = MAILTO.exec(value)) {
      text(value.slice(last, match.index));
      out.push({ kind: "link", url: match[2]!, label: match[1]! });
      last = match.index + match[0].length;
    }
    text(value.slice(last));
  };
  const one = (token: Token) => {
    switch (token.kind) {
      case "text":
        return mailtoSplit(token.text);
      case "bold":
      case "italic":
      case "strike":
      case "code":
        return out.push({ kind: token.kind, text: token.text });
      case "link":
        return /^https?:\/\//i.test(token.url) ? out.push({ kind: "link", url: token.url, label: token.label }) : text(token.label ?? token.url);
      case "mention":
        return text(`@${nameOf(token.userId) ?? "unknown"}`);
      case "mention_group":
        return text("@group");
      case "mention_all":
        return text(`@${token.target}`);
      case "math":
        return text(token.display ? `$$${token.text}$$` : `$${token.text}$`);
      case "codeblock":
        return text(token.text);
      case "newline":
        return text(" ");
    }
  };
  for (const token of tokenizeInline(topic.replace(/\s*\n\s*/g, " "))) one(token);
  return out;
}

/** A link on this server opened in the app (true), or not one of ours (false: the browser opens it). */
export function openInternalLink(controller: AppController, base: string | null | undefined, url: string): boolean {
  if (!base) return false;
  const message = parsePermalink(base, url);
  if (message) return void controller.openPermalink(message), true;
  const canvas = parseCanvasLink(base, url);
  if (canvas) return void controller.openCanvasLink(canvas), true;
  const page = parsePageLink(base, url);
  if (page) return controller.requestOpenPage(page), true;
  const event = parseEventLink(base, url);
  if (event) return controller.requestOpenEvent(event), true;
  const drive = parseDriveLink(base, url);
  if (drive) return void controller.openDriveLink(drive), true;
  const equipment = parseEquipmentLink(base, url);
  if (equipment) return controller.requestOpenLending({ itemId: equipment, loanId: null }), true;
  return false;
}

/** True when the topic has a link (the header then shows it as text with links, not as one 「トピックを編集」 button). */
export function topicHasLink(topic: string): boolean {
  return topicTokens(topic).some((token) => token.kind === "link");
}

export function TopicText({ controller, topic, className }: { controller: AppController; topic: string; className?: string }) {
  const base = controller.api?.baseUrl ?? null;
  const tokens = topicTokens(topic, (id) => controller.store.users.get(id)?.display_name ?? null);
  const click = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    event.stopPropagation();
    if (!url.toLowerCase().startsWith("mailto:") && openInternalLink(controller, base, url)) {
      event.preventDefault();
      return;
    }
    openExternalLink(event, url);
  };
  const nodes: ReactNode[] = tokens.map((token, i) => {
    switch (token.kind) {
      case "text":
        return <span key={i}>{token.text}</span>;
      case "bold":
        return <strong key={i} className="font-semibold">{token.text}</strong>;
      case "italic":
        return <em key={i}>{token.text}</em>;
      case "strike":
        return <del key={i}>{token.text}</del>;
      case "code":
        return <code key={i} className="rounded bg-panel-2 px-1 font-mono text-[0.92em]">{token.text}</code>;
      case "link":
        return (
          <a
            key={i}
            href={token.url}
            target="_blank"
            rel="noreferrer noopener"
            title={token.url}
            className="text-accent hover:underline"
            onClick={(event) => click(event, token.url)}
          >
            {token.label ?? token.url}
          </a>
        );
    }
  });
  return <span className={cn(className)}>{nodes}</span>;
}
