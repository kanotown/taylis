#!/usr/bin/env node
// M115 (docs/I18N.md): lists the Japanese text left in the desktop/web sources outside comments and the
// dictionaries, so UI text that skipped src/i18n is found. Lines in ALLOWED stay Japanese on purpose (each with
// its reason). Exits 1 when an unexplained line is found.
//
//   node scripts/i18n-leftovers.mjs          # unexplained lines only
//   node scripts/i18n-leftovers.mjs --all    # also the allowed ones, with their reasons
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const JP = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60「」『』〜・]/u;
const SKIP = [/^src\/i18n\//, /emojiData\.ts$/, /errorMessages\.ts$/, /schema\.d\.ts$/];

const SHARED = "shared channel content, posted in Japanese for every reader (docs/I18N.md)";
const PATTERN = "matching rule for Japanese input, not UI text";
/** [file, a substring of the line, reason] */
const ALLOWED = [
  ["src/state/app.ts", 'case "日程"', "the /日程 command's name (typed by users; /schedule is the alias)"],
  ["src/ui/Composer.tsx", '"日程"', "the /日程 command's name"],
  ["src/ui/commands.ts", 'name: "日程"', "the /日程 command's name"],
  ["src/ui/commands.ts", '"明日"', "accepted input word next to 'tomorrow'"],
  ["src/ui/commands.ts", "SHRUG", "the shrug kaomoji (ツ) is the content"],
  ["src/ui/WorkspaceSettingsTab.tsx", "SUGGESTED_DEFAULTS", "names of channels created for a Japanese lab, not UI"],
  ["src/ui/canvasDiff.ts", "const WORD", PATTERN],
  ["src/ui/customEmoji.tsx", "text.split", PATTERN],
  ["src/ui/emoji.ts", "QUERY_TAIL", PATTERN],
  ["src/ui/jumpMatch.ts", "SEPARATORS", PATTERN],
  ["src/ui/links.ts", "replace(", PATTERN],
  ["src/ui/markdown.ts", "\\u3000", PATTERN],
  ["src/ui/richMarkdown.ts", "const PROTECTED", "the shrug kaomoji (ツ), as the renderer reads it (" + PATTERN + ")"],
  ["src/ui/richMarkdown.ts", '"］"', "a full-width bracket written for a `]` in a link's label (the dialect cannot hold `]` there)"],
  ["src/ui/sectionIcon.ts", "LETTER_TEXT", PATTERN],
  ["src/ui/Settings.tsx", "＋", "a symbol"],
  ["src/ui/Settings.tsx", '"日本語"', "language names are written in their own language"],
  ["src/ui/Dialogs.tsx", "・", "key names joined with a symbol"],
  ["src/ui/Dialogs.tsx", "1〜9", "key names joined with a symbol"],
  ["src/ui/recurring.ts", "JS_WEEKDAYS", "the {weekday} placeholder preview; the server expands it in Japanese (" + SHARED + ")"],
  ["src/ui/templates.ts", "const WEEKDAYS", "schedule poll options are " + SHARED],
  ["src/ui/templates.ts", "SCHEDULE_QUESTION", "schedule poll question is " + SHARED],
  ["src/ui/templates.ts", "TOKEN", PATTERN],
  ["src/ui/templates.ts", "〜${clock", "schedule poll options are " + SHARED],
  ["src/ui/workflows.ts", "WEEKDAYS_JA", "workflow answers are posted as " + SHARED],
  ["src/ui/workflows.ts", "年", "workflow answers are posted as " + SHARED],
  ["src/ui/workflows.ts", "＜", "escapes '<' in posted answers"],
  ["src/ui/workflows.ts", "はい", "workflow answers are posted as " + SHARED],
  ["src/ui/navItems.ts", "label:", "mirror of apps/shared/nav-items.json (the server's default labels); navLabel() shows the localized one"],
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Blanks out comments and keeps strings, so the line numbers stay. */
function stripComments(text) {
  let out = "";
  let state = null;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === null) {
      if (c === '"' || c === "'" || c === "`") {
        state = "str";
        quote = c;
        out += c;
      } else if (text.startsWith("//", i) && text[i - 1] !== ":") {
        state = "line";
        out += " ";
      } else if (text.startsWith("/*", i)) {
        state = "block";
        out += " ";
      } else out += c;
    } else if (state === "str") {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[++i];
      else if (c === quote || (c === "\n" && quote !== "`")) state = null;
    } else if (state === "line") {
      if (c === "\n") {
        state = null;
        out += "\n";
      } else out += " ";
    } else if (text.startsWith("*/", i)) {
      state = null;
      out += "  ";
      i++;
    } else out += c === "\n" ? "\n" : " ";
  }
  return out;
}

const showAll = process.argv.includes("--all");
let unexplained = 0;
let allowed = 0;
for (const path of walk(join(ROOT, "src"), []).sort()) {
  const file = relative(ROOT, path).split("\\").join("/");
  if (SKIP.some((re) => re.test(file))) continue;
  const text = readFileSync(path, "utf8");
  const raw = text.split("\n");
  stripComments(text)
    .split("\n")
    .forEach((line, i) => {
      if (!JP.test(line)) return;
      const rule = ALLOWED.find(([f, needle]) => f === file && raw[i].includes(needle));
      if (rule) {
        allowed++;
        if (showAll) console.log(`allowed  ${file}:${i + 1}  ${rule[2]}`);
      } else {
        unexplained++;
        console.log(`LEFTOVER ${file}:${i + 1}  ${raw[i].trim()}`);
      }
    });
}
console.log(`${unexplained} unexplained, ${allowed} allowed`);
process.exit(unexplained ? 1 : 0);
