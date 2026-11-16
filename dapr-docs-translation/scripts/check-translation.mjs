#!/usr/bin/env node
// check-translation — structural checks for a translated Markdown/MDX document. Node built-ins only;
// Same-document anchors are checked with a built-in github-slugger equivalent.
//
//   check-translation.mjs <source.md> <translation.md>
//       [--translatable title,description]   frontmatter keys whose values may differ (default: title,description)
//       [--glossary glossary.json]           enables the soft glossary checks: preferred renderings used (glossary),
//                                            one rendering shared by several source terms present in the text (term-collision)
//       [--min-cjk-ratio 0.2]                soft check; use for Chinese/Japanese/Korean targets only
//       [--cjk-punctuation]                  hard check: no ASCII , . : ; ! ? ( ) right next to CJK text, or between an inline
//                                            code span and following CJK text (full-width expected)
//       [--fence-comments translate]         fenced code: a line may differ from the source in its comment text only
//                                            (code before the comment marker and the line count stay identical); default: verbatim
//       [--inline-placeholders translate]    inline code: a span may be replaced one-for-one by a span containing CJK
//                                            (prose placeholders such as `[HOST NAME]`); default: verbatim
//       [--localized-urls allow]             links: an external URL may gain or lose a leading zh locale path segment
//                                            (learn.microsoft.com/dotnet/x vs learn.microsoft.com/zh-cn/dotnet/x); default: exact
//
// Prints JSON {ok, hard:[{check,message}], soft:[{check,message}]}.
// Exit codes: 0 no hard failure, 1 hard failure, 2 usage / unreadable file.
import { readFileSync } from "node:fs";
import { decodeFragment, headingList, slugList } from "./lib/anchors.mjs";

const args = process.argv.slice(2);
const files = [];
const opt = {};
const BOOLEAN_FLAGS = new Set(["cjk-punctuation"]);
for (let i = 0; i < args.length; i += 1) {
  if (!args[i].startsWith("--")) files.push(args[i]);
  else if (BOOLEAN_FLAGS.has(args[i].slice(2))) opt[args[i].slice(2)] = true;
  else opt[args[i].slice(2)] = args[(i += 1)];
}
if (files.length !== 2) {
  console.error("usage: check-translation.mjs <source.md> <translation.md> [--translatable a,b] [--glossary file] [--min-cjk-ratio n]");
  process.exit(2);
}

const hard = [];
const soft = [];
const fail = (check, message) => hard.push({ check, message });
const warn = (check, message) => soft.push({ check, message });
const translatable = new Set((opt.translatable ?? "title,description").split(",").map((s) => s.trim()).filter(Boolean));

function read(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    console.error(`cannot read ${file}: ${error.code ?? error.message}`);
    process.exit(2);
  }
  try {
    return { bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { bytes, text: null };
  }
}
const src = read(files[0]);
const dst = read(files[1]);
if (src.text === null) {
  console.error("source is not valid UTF-8");
  process.exit(2);
}
if (dst.text === null) {
  fail("format", "translation is not valid UTF-8");
  report();
}

// ---- format ----
if (dst.bytes[0] === 0xef && dst.bytes[1] === 0xbb && dst.bytes[2] === 0xbf) fail("format", "translation has a BOM");
if (dst.text.includes("\r")) fail("format", "translation contains \\r");
if (!/[^\n]\n$/.test(dst.text)) fail("format", "translation must end with exactly one newline");

// ---- parsing helpers ----
function split(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let front = [];
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      front = lines.slice(1, end);
      start = end + 1;
    }
  }
  return { front, body: lines.slice(start) };
}

function frontBlocks(front) {
  const blocks = [];
  for (const line of front) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) blocks.push({ key: line.slice(0, line.indexOf(":")).trim(), lines: [line] });
    else if (blocks.length) blocks.at(-1).lines.push(line);
  }
  return blocks;
}

// Separate fenced code (kept verbatim) from prose; prose keeps one placeholder line per fence.
function fences(lines) {
  const prose = [];
  const code = [];
  let open = null;
  let buffer = [];
  for (const line of lines) {
    if (open) {
      buffer.push(line);
      const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === open.char && m[1].length >= open.len) {
        code.push(buffer.join("\n"));
        open = null;
        buffer = [];
      }
      continue;
    }
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { char: m[1][0], len: m[1].length };
      buffer = [line];
      prose.push("\u0000FENCE\u0000");
    } else prose.push(line);
  }
  if (open) code.push(buffer.join("\n")); // unterminated fence still compared verbatim
  return { prose, code };
}

function inlineCode(text) {
  const spans = [];
  // a code span lives inside one paragraph (CommonMark): it never pairs a stray backtick with one past a blank line, which would
  // swallow the headings, tables and links in between
  const rest = text.replace(/(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g, (_, ticks, content) => {
    spans.push(content);
    return "\u0000CODE\u0000";
  });
  return { spans, rest };
}

function analyse(text) {
  const { front, body } = split(text);
  const { prose, code } = fences(body);
  const { spans, rest } = inlineCode(prose.join("\n"));
  const lines = rest.split("\n");
  const headings = [];
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (h) headings.push({ level: h[1].length, text: h[2] });
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i]) && i > 0 && lines[i - 1].includes("|")) {
      let end = i + 1;
      while (end < lines.length && lines[end].includes("|") && lines[end].trim()) end += 1;
      const cols = (row) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).length;
      tables.push({ rows: end - (i - 1), cols: cols(lines[i - 1]) });
      i = end - 1;
    }
  }
  const links = [];
  for (const m of rest.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) links.push(m[1]);
  for (const m of rest.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm)) links.push(m[1]);
  for (const m of rest.matchAll(/<(https?:\/\/[^>\s]+)>/g)) links.push(m[1]);
  const tags = [...rest.matchAll(/<(\/?)([A-Za-z][\w-]*)(?:\s[^<>]*)?(\/?)>/g)].map((m) => `${m[1]}${m[2].toLowerCase()}${m[3]}`);
  return { front: frontBlocks(front), code, spans, headings, tables, links, tags, rest };
}

const a = analyse(src.text);
const b = analyse(dst.text);

// ---- frontmatter ----
const keysA = a.front.map((x) => x.key);
const keysB = b.front.map((x) => x.key);
if (keysA.join("\n") !== keysB.join("\n")) fail("frontmatter", `keys differ: [${keysA}] vs [${keysB}]`);
else {
  a.front.forEach((blockA, i) => {
    if (!translatable.has(blockA.key) && blockA.lines.join("\n") !== b.front[i].lines.join("\n")) {
      fail("frontmatter", `value of non-translatable key "${blockA.key}" changed`);
    }
  });
}

// ---- fenced code: count and verbatim content (comment text may be translated under --fence-comments translate) ----
// Comment markers recognised on a line: // # -- ; % /* * */ <!--. The part of the line before the marker must match exactly.
const COMMENT_ONLY = /^\s*(?:\/\/|#|--|;|%|\/\*|\*\/|\*(?:\s|$)|<!--|REM\s)/;
const TRAILING_COMMENT = /(?:^|\s)(?:\/\/|#|--|\/\*|<!--)(?:\s|$|[^\s/])/;
function codeOfLine(line, state) {
  if (state.block) {
    if (line.includes("*/")) state.block = false;
    return null; // inside a block comment: all comment
  }
  if (COMMENT_ONLY.test(line)) {
    if (/^\s*\/\*/.test(line) && !line.includes("*/")) state.block = true;
    return "";
  }
  const m = TRAILING_COMMENT.exec(line);
  if (m) {
    const at = m.index + (m[0].startsWith(" ") || m[0].startsWith("\t") ? 1 : 0);
    // a `//` right after a colon is a URL scheme, not a comment
    if (line[at - 1] === ":" ) return line;
    if (/\/\*/.test(line.slice(at, at + 2)) && !line.includes("*/", at)) state.block = true;
    return line.slice(0, at).trimEnd();
  }
  return line;
}
// Under --fence-comments translate a block matches when its code lines (comments and blank lines dropped, trailing
// whitespace ignored) are identical and the fence lines agree; comment text and comment-only lines may change freely.
function sameCodeIgnoringComments(x, y) {
  const codeLines = (block) => {
    const lines = block.split("\n");
    const state = { block: false };
    const kept = [lines[0].trimEnd(), lines.at(-1).trimEnd()];
    const body = [];
    for (const line of lines.slice(1, -1)) {
      const code = codeOfLine(line, state);
      if (code === null || code.trim() === "") continue;
      body.push(code.trimEnd());
    }
    return [kept[0], ...body, kept[1]];
  };
  const cx = codeLines(x);
  const cy = codeLines(y);
  return cx.length === cy.length && cx.every((line, i) => line === cy[i]);
}
if (a.code.length !== b.code.length) fail("code-fence", `fenced block count ${a.code.length} vs ${b.code.length}`);
else {
  a.code.forEach((block, i) => {
    if (block === b.code[i]) return;
    if (opt["fence-comments"] === "translate" && sameCodeIgnoringComments(block, b.code[i])) return;
    fail("code-fence", `fenced block #${i + 1} differs from the source${opt["fence-comments"] === "translate" ? " beyond comment text" : ""}`);
  });
}

// ---- inline code multiset ----
const sorted = (xs) => [...xs].sort();
if (sorted(a.spans).join("\u0001") !== sorted(b.spans).join("\u0001")) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a.spans);
  const cb = count(b.spans);
  // spans present on one side only (multiset difference)
  const onlySrc = [];
  const onlyDst = [];
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    const d = (ca.get(k) ?? 0) - (cb.get(k) ?? 0);
    for (let n = 0; n < Math.abs(d); n += 1) (d > 0 ? onlySrc : onlyDst).push(k);
  }
  const CJK_SPAN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
  const placeholdersOk = opt["inline-placeholders"] === "translate" && onlySrc.length === onlyDst.length && onlyDst.every((x) => CJK_SPAN.test(x));
  if (!placeholdersOk) {
    const diff = [...new Set([...ca.keys(), ...cb.keys()])].filter((k) => ca.get(k) !== cb.get(k)).slice(0, 5);
    fail("inline-code", `inline code spans differ (${a.spans.length} vs ${b.spans.length}); e.g. ${diff.map((d) => JSON.stringify(d)).join(", ")}`);
  }
}

// ---- headings ----
const lv = (h) => h.map((x) => x.level).join(",");
if (lv(a.headings) !== lv(b.headings)) fail("headings", `heading level sequence differs (${a.headings.length} vs ${b.headings.length} headings)`);

// ---- tables ----
const tb = (t) => t.map((x) => `${x.rows}x${x.cols}`).join(",");
if (tb(a.tables) !== tb(b.tables)) fail("tables", `table shapes differ: [${tb(a.tables)}] vs [${tb(b.tables)}]`);

// ---- html tags ----
if (sorted(a.tags).join(",") !== sorted(b.tags).join(",")) fail("html", "HTML tag multiset differs");

// ---- links: same sequence; same-document fragments may change but must resolve ----
// a trailing slash on an external URL (https://example.org vs https://example.org/) names the same target
// --localized-urls allow: a leading zh locale segment (/zh-cn/, /zh-hans/, /zh/ ...) right after the host names the same page
const LOCALE_SEGMENT = /^(https?:\/\/[^/]+)\/zh(?:-(?:cn|hans|tw|hant|hk))?(?=\/|$|#|\?)/i;
const norm = (t) => {
  if (t.startsWith("#")) return "#";
  if (!/^https?:\/\//.test(t)) return t;
  const u = opt["localized-urls"] === "allow" ? t.replace(LOCALE_SEGMENT, "$1") : t;
  return u.replace(/\/(?=$|#|\?)/, "");
};
if (a.links.map(norm).join("\n") !== b.links.map(norm).join("\n")) {
  const first = a.links.findIndex((t, i) => norm(t) !== norm(b.links[i] ?? ""));
  fail("links", `link/image targets differ (${a.links.length} vs ${b.links.length}); first difference at #${first + 1}: ${JSON.stringify(a.links[first])} vs ${JSON.stringify(b.links[first])}`);
}

// ---- anchors ----
// Heading slugs come from lib/anchors.mjs (a dependency-free github-slugger equivalent).
{
  const sa = new Set(slugList(headingList(src.text)));
  const sb = new Set(slugList(headingList(dst.text)));
  a.links.forEach((target, i) => {
    const t = b.links[i];
    if (!target?.startsWith("#") || !t?.startsWith("#")) return;
    const wasOk = sa.has(decodeFragment(target.slice(1)).toLowerCase()) || sa.has(target.slice(1));
    const isOk = sb.has(decodeFragment(t.slice(1)).toLowerCase()) || sb.has(t.slice(1));
    if (wasOk && !isOk) fail("anchors", `${t} does not resolve to a translated heading (source ${target} did)`);
  });
}

// ---- CJK punctuation (hard, opt-in) ----
const prose = (x) => x.rest
  .replace(/\u0000(FENCE|CODE)\u0000/g, " ")
  .replace(/\]\([^)]*\)/g, "]")
  .replace(/<[^>]+>/g, " ");
if (opt["cjk-punctuation"]) {
  const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af";
  const withCode = b.rest.replace(/\u0000FENCE\u0000/g, " ").replace(/\]\([^)]*\)/g, "]").replace(/<[^>]+>/g, " ");
  const bad = [...withCode.matchAll(new RegExp(`[${CJK}][,.:;!?]|[${CJK}]\\(|\\)[${CJK}]|\\u0000CODE\\u0000[,;:!?](?=\\s*[${CJK}])`, "g"))];
  if (bad.length) {
    const sample = bad.slice(0, 5).map((m) => JSON.stringify(m[0].replace(/\u0000CODE\u0000/g, "`…`"))).join(", ");
    fail("cjk-punctuation", `${bad.length} ASCII punctuation mark(s) next to CJK text (use full-width , 。 : ; ! ? ( ) ); e.g. ${sample}`);
  }
}

// ---- soft: numbers ----
const digits = (x) => sorted(prose(x).match(/\d+(?:\.\d+)*/g) ?? []).join(",");
if (digits(a) !== digits(b)) warn("numbers", "numbers in prose differ from the source (check for dropped or altered values)");

// ---- soft: CJK ratio ----
if (opt["min-cjk-ratio"] !== undefined) {
  const text = prose(b);
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const ratio = cjk / Math.max(1, cjk + latin);
  if (ratio < Number(opt["min-cjk-ratio"])) warn("untranslated", `CJK share of prose is ${ratio.toFixed(2)}; large untranslated passages are likely`);
}

// ---- soft: glossary usage, compared by number of occurrences ----
if (opt.glossary) {
  try {
    const glossary = JSON.parse(readFileSync(opt.glossary, "utf8"));
    const lower = prose(a).toLowerCase();
    const targetText = prose(b);
    const under = [];
    const present = []; // glossary terms that occur in this document
    for (const term of glossary.terms ?? []) {
      const target = term.target ?? term.zh;
      const re = new RegExp(`(?<![\\w-])${term.source.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?(?![\\w-])`, "g");
      const inSource = (lower.match(re) ?? []).length;
      if (!inSource) continue;
      present.push({ source: term.source.toLowerCase(), target });
      const inTarget = targetText.split(target).length - 1;
      if (inTarget < inSource) under.push(`${term.source} → ${target} (source ×${inSource}, translation ×${inTarget})`);
    }
    // two different source words sharing one preferred rendering, both present here: readers cannot tell them apart
    const byTarget = new Map();
    for (const t of present) {
      if (!t.target) continue;
      if (!byTarget.has(t.target)) byTarget.set(t.target, new Set());
      byTarget.get(t.target).add(t.source);
    }
    const clashes = [...byTarget].filter(([, sources]) => sources.size > 1).map(([target, sources]) => `${target} ← ${[...sources].join(" / ")}`);
    if (clashes.length) warn("term-collision", `one preferred rendering stands for several source terms that both occur in this document, so readers cannot tell them apart: ${clashes.slice(0, 10).join("; ")}${clashes.length > 10 ? " …" : ""}`);
    if (under.length) warn("glossary", `preferred rendering used fewer times than the term occurs in the source: ${under.slice(0, 10).join("; ")}${under.length > 10 ? " …" : ""}`);
  } catch (error) {
    warn("glossary", `glossary could not be read: ${error.message}`);
  }
}

report();

function report() {
  console.log(JSON.stringify({ ok: hard.length === 0, hard, soft }, null, 2));
  process.exit(hard.length ? 1 : 0);
}
