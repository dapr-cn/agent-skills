#!/usr/bin/env node
// check-translation — structural checks for a translated Markdown/MDX document. Node built-ins only;
// `github-slugger` is used for anchor checks when it resolves from the current directory.
//
//   check-translation.mjs <source.md> <translation.md>
//       [--translatable title,description]   frontmatter keys whose values may differ (default: title,description)
//       [--glossary glossary.json]           enables the soft glossary checks: preferred renderings used (glossary),
//                                            one rendering shared by several source terms present in the text (term-collision)
//       [--min-cjk-ratio 0.2]                soft check; use for Chinese/Japanese/Korean targets only
//       [--cjk-punctuation]                  hard check: no ASCII , . : ; ! ? ( ) right next to CJK text, or between an inline
//                                            code span and following CJK text (full-width expected)
//
// Prints JSON {ok, hard:[{check,message}], soft:[{check,message}]}.
// Exit codes: 0 no hard failure, 1 hard failure, 2 usage / unreadable file.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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
  const rest = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, content) => {
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

// ---- fenced code: count and verbatim content ----
if (a.code.length !== b.code.length) fail("code-fence", `fenced block count ${a.code.length} vs ${b.code.length}`);
else a.code.forEach((block, i) => block !== b.code[i] && fail("code-fence", `fenced block #${i + 1} differs from the source`));

// ---- inline code multiset ----
const sorted = (xs) => [...xs].sort();
if (sorted(a.spans).join("\u0001") !== sorted(b.spans).join("\u0001")) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a.spans);
  const cb = count(b.spans);
  const diff = [...new Set([...ca.keys(), ...cb.keys()])].filter((k) => ca.get(k) !== cb.get(k)).slice(0, 5);
  fail("inline-code", `inline code spans differ (${a.spans.length} vs ${b.spans.length}); e.g. ${diff.map((d) => JSON.stringify(d)).join(", ")}`);
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
const norm = (t) => (t.startsWith("#") ? "#" : t);
if (a.links.map(norm).join("\n") !== b.links.map(norm).join("\n")) {
  const first = a.links.findIndex((t, i) => norm(t) !== norm(b.links[i] ?? ""));
  fail("links", `link/image targets differ (${a.links.length} vs ${b.links.length}); first difference at #${first + 1}: ${JSON.stringify(a.links[first])} vs ${JSON.stringify(b.links[first])}`);
}

// ---- anchors ----
let Slugger;
for (const base of [process.cwd(), path.dirname(path.resolve(files[1])), path.dirname(path.resolve(files[0]))]) {
  try {
    Slugger = (await import(createRequire(path.join(base, "noop.js")).resolve("github-slugger"))).default;
    break;
  } catch {
    // try the next location
  }
}
if (!Slugger) warn("anchor-check-skipped", "github-slugger could not be resolved from the working directory or the file locations; same-document anchors were not verified");
if (Slugger) {
  const slugs = (headings) => {
    const s = new Slugger();
    return new Set(headings.map((h) => s.slug(h.text.replace(/[*_`]|<[^>]+>|\[([^\]]*)\]\([^)]*\)/g, "$1"))));
  };
  const sa = slugs(a.headings);
  const sb = slugs(b.headings);
  a.links.forEach((target, i) => {
    const t = b.links[i];
    if (!target?.startsWith("#") || !t?.startsWith("#")) return;
    const wasOk = sa.has(decodeURIComponent(target.slice(1)).toLowerCase()) || sa.has(target.slice(1));
    const isOk = sb.has(decodeURIComponent(t.slice(1)).toLowerCase()) || sb.has(t.slice(1));
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
