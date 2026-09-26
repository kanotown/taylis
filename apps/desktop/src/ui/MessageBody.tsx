import type { UserPublic } from "../api/types";
import { type Block, parseBlocks, type Token } from "./markdown";
import { cn } from "./primitives";

/** Renders the light markdown subset (DATA_MODEL.md "本文の形式"); mentions resolve to display names. */
export function MessageBody({ body, users, className }: { body: string; users: Map<string, UserPublic>; className?: string }) {
  return (
    <div className={cn("body text-[14.5px] leading-6", className)}>
      {parseBlocks(body).map((block, i) => (
        <BlockView key={i} block={block} users={users} />
      ))}
    </div>
  );
}

function BlockView({ block, users }: { block: Block; users: Map<string, UserPublic> }) {
  switch (block.kind) {
    case "heading": {
      const size = block.level === 1 ? "text-xl font-bold" : block.level === 2 ? "text-lg font-bold" : "text-base font-semibold";
      return <div className={cn("mt-1 leading-tight", size)}>{inline(block.tokens, users)}</div>;
    }
    case "paragraph":
      return <p className="m-0">{lines(block.lines, users)}</p>;
    case "quote":
      return <blockquote className="my-1 border-l-[3px] border-line pl-3 text-muted">{lines(block.lines, users)}</blockquote>;
    case "list":
      return block.ordered ? (
        <ol start={block.start} className="my-0.5 list-decimal pl-6">
          {block.items.map((item, i) => (
            <li key={i} className={item.level > 0 ? "ml-4 list-[lower-alpha]" : undefined}>{inline(item.tokens, users)}</li>
          ))}
        </ol>
      ) : (
        <ul className="my-0.5 list-disc pl-6">
          {block.items.map((item, i) => (
            <li key={i} className={item.level > 0 ? "ml-4 list-[circle]" : undefined}>{inline(item.tokens, users)}</li>
          ))}
        </ul>
      );
    case "codeblock":
      return (
        <pre className="relative my-1">
          {block.lang && <span className="absolute right-2 top-1 text-[10px] uppercase tracking-wide text-muted">{block.lang}</span>}
          {block.text}
        </pre>
      );
  }
}

function lines(rows: Token[][], users: Map<string, UserPublic>) {
  return rows.map((tokens, i) => (
    <span key={i}>
      {i > 0 && <br />}
      {inline(tokens, users)}
    </span>
  ));
}

export function inline(tokens: Token[], users: Map<string, UserPublic>) {
  return tokens.map((token, i) => {
    switch (token.kind) {
      case "text":
        return <span key={i}>{token.text}</span>;
      case "bold":
        return <strong key={i}>{token.text}</strong>;
      case "italic":
        return <em key={i}>{token.text}</em>;
      case "strike":
        return <del key={i}>{token.text}</del>;
      case "code":
        return <code key={i}>{token.text}</code>;
      case "codeblock":
        return <pre key={i}>{token.text}</pre>;
      case "link":
        return (
          <a key={i} href={token.url} target="_blank" rel="noreferrer noopener" title={token.label ? token.url : undefined}>
            {token.label ?? token.url}
          </a>
        );
      case "mention":
        return (
          <span key={i} className="mention">
            @{users.get(token.userId)?.display_name ?? "unknown"}
          </span>
        );
      case "mention_all":
        return (
          <span key={i} className="mention">
            @{token.target}
          </span>
        );
      case "newline":
        return <br key={i} />;
    }
  });
}
