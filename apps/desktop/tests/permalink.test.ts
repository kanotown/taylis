import { describe, expect, it } from "vitest";

import { messagePermalink, parsePermalink } from "../src/ui/permalink";

describe("message permalinks (M12b)", () => {
  const id = "01a0df3f-14b2-7d1a-8759-53c8a8d8a198";
  it("builds <server>/m/<id> without doubling slashes", () => {
    expect(messagePermalink("https://chat.example.com/", id)).toBe(`https://chat.example.com/m/${id}`);
    expect(messagePermalink("http://127.0.0.1:8000", id)).toBe(`http://127.0.0.1:8000/m/${id}`);
  });
  it("recognises only our own server and a well-formed id", () => {
    expect(parsePermalink("https://chat.example.com", `https://chat.example.com/m/${id}`)).toBe(id);
    expect(parsePermalink("https://chat.example.com/", `HTTPS://CHAT.EXAMPLE.COM/m/${id.toUpperCase()}?x=1#y`)).toBe(id);
    expect(parsePermalink("https://chat.example.com", `https://chat.example.com/m/${id}/extra`)).toBe(id);
    expect(parsePermalink("https://chat.example.com", "https://chat.example.com/m/not-an-id")).toBeNull();
    expect(parsePermalink("https://chat.example.com", `https://other.example.com/m/${id}`)).toBeNull();
    expect(parsePermalink("https://chat.example.com", `https://chat.example.com/files/${id}`)).toBeNull();
  });
});
