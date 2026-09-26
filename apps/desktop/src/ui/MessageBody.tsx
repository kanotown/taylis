import type { UserPublic } from "../api/types";
import { tokenize } from "./markdown";

export function MessageBody({ body, users }: { body: string; users: Map<string, UserPublic> }) {
  return (
    <div className="body">
      {tokenize(body).map((token, i) => {
        switch (token.kind) {
          case "text":
            return <span key={i}>{token.text}</span>;
          case "bold":
            return <strong key={i}>{token.text}</strong>;
          case "italic":
            return <em key={i}>{token.text}</em>;
          case "code":
            return <code key={i}>{token.text}</code>;
          case "codeblock":
            return <pre key={i}>{token.text}</pre>;
          case "link":
            return (
              <a key={i} href={token.url} target="_blank" rel="noreferrer noopener">
                {token.url}
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
      })}
    </div>
  );
}
