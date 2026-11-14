// First-time glossary bootstrap from an existing translation of the same documents (references/glossary-and-style.md §2).
// Deterministic: pairs a source document with its external translation by path, aligns their structure (headings, table
// first columns, bold terms), reads "译名（Original）" annotations, counts agreeing pairs across documents and keeps the
// ones that at least `minDocs` documents agree on. No model is involved.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { proseOf, slugOf, termRegExp } from "./jobs.mjs";
import { screenCandidate } from "./glossary.mjs";

const CJK = /[㐀-鿿぀-ヿ가-힯]/;

// ------------------------------------------------------------------------------------------------ extraction

const clean = (s) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`[^`]*`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{#[^}]+\}\s*$/, "")
    .replace(/\*+|_{2,}/g, "")
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}️\s]+/gu, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/[:：]\s*$/, "")
    .trim();

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (row) => cells(row).every((c) => /^:?-{2,}:?$/.test(c));

/**
 * Ordered slots of a Markdown document: headings, tables (first column) and bold terms, each remembering the section
 * (number of headings before it) it sits in. Fenced code and frontmatter are skipped.
 */
export function extractSlots(text) {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
    if (end > 0) lines = lines.slice(end + 1);
  }
  const headings = [];
  const tables = [];
  const bold = [];
  let fence = null;
  let table = null;
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      table = null;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (!table) {
        table = { sec: headings.length, rows: [] };
        tables.push(table);
      }
      if (!isSeparator(line)) table.rows.push(clean(cells(line)[0] ?? ""));
      continue;
    }
    table = null;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      headings.push({ level: h[1].length, text: clean(h[2]) });
      continue;
    }
    for (const m of line.replace(/`[^`]*`/g, "").matchAll(/\*\*([^*\n]+)\*\*/g)) bold.push({ sec: headings.length, text: clean(m[1]) }); // bold inside inline code is code
  }
  return { headings, tables, bold };
}

/**
 * Align the slots of a source document with those of its translation. Headings are aligned when their count and levels
 * agree. With aligned headings, tables and bold terms are aligned section by section: a section whose counts do not
 * match is dropped (never forced) and the others still count. Without aligned headings each category is all-or-nothing.
 * Returns { pairs: [{category, src, tgt}], aligned: [...], failed: [...] }.
 */
export function alignSlots(a, b) {
  const pairs = [];
  const aligned = [];
  const failed = [];
  const hOk = a.headings.length > 0 && a.headings.length === b.headings.length && a.headings.every((h, i) => h.level === b.headings[i].level);
  if (hOk) {
    aligned.push("headings");
    a.headings.forEach((h, i) => h.level > 1 && pairs.push({ category: "headings", src: h.text, tgt: b.headings[i].text })); // a level-1 heading is the document title, not a term
  } else if (a.headings.length || b.headings.length) failed.push("headings");

  const sections = hOk ? [...Array(a.headings.length + 1).keys()] : [null]; // null = the whole document at once
  const inSec = (list, sec) => (sec === null ? list : list.filter((x) => x.sec === sec));
  const run = (category, A, B, same, emit) => {
    if (!A.length && !B.length) return;
    let ok = 0;
    let bad = 0;
    for (const sec of sections) {
      const sa = inSec(A, sec);
      const sb = inSec(B, sec);
      if (!sa.length && !sb.length) continue;
      if (same(sa, sb)) {
        ok += 1;
        emit(sa, sb);
      } else bad += 1;
    }
    if (ok) aligned.push(category);
    if (bad) failed.push(ok ? `${category} (${bad} of ${ok + bad} sections)` : category);
  };
  run("tables", a.tables, b.tables, (x, y) => x.length === y.length && x.every((t, i) => t.rows.length === y[i].rows.length),
    (x, y) => x.forEach((t, i) => t.rows.forEach((cell, j) => pairs.push({ category: "tables", src: cell, tgt: y[i].rows[j] }))));
  run("bold", a.bold, b.bold, (x, y) => x.length === y.length, (x, y) => x.forEach((t, i) => pairs.push({ category: "bold", src: t.text, tgt: y[i].text })));
  return { pairs, aligned, failed };
}

/** "译名（Original）" annotations in the translation whose Original occurs in the source prose. */
export function parenPairs(translation, sourceText) {
  const prose = proseOf(sourceText);
  const out = [];
  for (const m of translation.matchAll(/([㐀-鿿][㐀-鿿A-Za-z0-9 ·]{0,10})[（(]([A-Za-z][A-Za-z0-9 .\-/]{2,32})[）)]/g)) {
    // the CJK text before the parenthesis often starts with a verb or particle ("使用路由器（Router）"): those are not part of the term
    const tgt = m[1].trim().replace(/^(?:使用|通过|利用|用|和|与|及|或|在|对|把|将|为|的|是|有|从|到|请|可|以|按|由)+/, "");
    if (tgt && termRegExp(m[2].trim()).test(prose)) out.push({ category: "paren", src: m[2].trim(), tgt });
  }
  return out;
}

/** A usable (source, rendering) pair, or null: short Latin source, short rendering (CJK, or identical for a name kept as is). */
export function normalisePair(p) {
  const src = clean(p.src ?? "");
  let tgt = clean(p.tgt ?? "");
  const m = /^(.+?)\s*[（(]([^）)]+)[）)]$/.exec(tgt);
  if (m && m[2].trim().toLowerCase() === src.toLowerCase()) tgt = m[1].trim();
  tgt = tgt.replace(/[，。；！？,.;!?]+$/, "").trim();
  if (!src || !tgt) return null;
  if (!/[A-Za-z]/.test(src) || CJK.test(src)) return null;
  if (src.split(/\s+/).length > 4 || src.length > 40 || tgt.length > 16) return null;
  if (tgt !== src && !CJK.test(tgt)) return null;
  return { ...p, src, tgt };
}

// ------------------------------------------------------------------------------------------------ evidence files

function walk(root, rel = "") {
  const out = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, child));
    else if (/\.(md|mdx)$/i.test(e.name)) out.push(child);
  }
  return out;
}

/**
 * For each document, the evidence file whose path shares the longest suffix with it (at least the file name; ties are skipped).
 * Works for layouts like `<doc>` ↔ `<evidence>/<doc>` and `docs/x/Y.md` ↔ `<evidence>/docs/x/Y.md`.
 */
export function matchEvidence(docNames, evidenceDirs) {
  const files = [];
  for (const dir of evidenceDirs) if (existsSync(dir) && statSync(dir).isDirectory()) for (const rel of walk(dir)) files.push({ abs: path.join(dir, rel), parts: rel.split("/") });
  const byName = new Map();
  for (const f of files) {
    const k = f.parts.at(-1);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }
  const out = new Map();
  for (const doc of docNames) {
    const parts = doc.split("/");
    const candidates = byName.get(parts.at(-1)) ?? [];
    let best = null;
    let bestLen = 0;
    let tie = false;
    for (const f of candidates) {
      let n = 0;
      while (n < parts.length && n < f.parts.length && parts[parts.length - 1 - n] === f.parts[f.parts.length - 1 - n]) n += 1;
      if (n > bestLen) {
        best = f;
        bestLen = n;
        tie = false;
      } else if (n === bestLen) tie = true;
    }
    if (best && !tie && (bestLen >= 2 || parts.length === 1)) out.set(doc, best.abs);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ building

const normTitle = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Extra, bootstrap-only precision rules: it learns from emphasis and labels, so it is stricter than the normal gate. */
function bootstrapReject(source, target, titles) {
  if (titles.has(normTitle(source))) return "title: the name of a document, not a term";
  // a Capitalised label cut out of a sentence: 3+ words with an ordinary lowercase word after the first ("Two concurrent long")
  const words = source.split(/\s+/);
  if (words.length >= 3 && words.slice(1).some((w) => /^[a-z]/.test(w) && !/^(of|and|or|to|in|for|with|by|on|the|a|an|as)$/.test(w))) return "too-long: a sentence fragment, not a term";
  if (/^[a-z]/.test(source)) return "lowercase-start: bootstrap only learns capitalised labels and names (prose terms arrive through translation runs)";
  const latin = target.match(/[A-Za-z][A-Za-z0-9-]+/g) ?? [];
  const sourceWords = new Set((source.match(/[A-Za-z][A-Za-z0-9-]+/g) ?? []).map((w) => w.toLowerCase()));
  if (latin.some((w) => !sourceWords.has(w.toLowerCase()))) return "misaligned: the rendering has Latin text the source does not";
  return null;
}

const keyOf = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/s$/, "");

/**
 * pairsByDoc: Map<doc, [{src, tgt}]> (already normalised). A pair counts once per document.
 * Returns { terms, doNotTranslate, ambiguous, rejected, collisions } — terms/doNotTranslate carry `docs`.
 */
export function buildBootstrap(pairsByDoc, { minDocs = 2, maxTerms = 150, ignore = new Set(), seeds = [], titles = new Set() } = {}) {
  const terms = new Map(); // key → { sources: Map(src → n), targets: Map(tgt → Set(docs)) }
  const names = new Map(); // exact-case source kept as is → Set(docs)
  for (const [doc, pairs] of pairsByDoc) {
    for (const p of pairs) {
      if (p.tgt === p.src) {
        if (!names.has(p.src)) names.set(p.src, new Set());
        names.get(p.src).add(doc);
        continue;
      }
      const k = keyOf(p.src);
      if (!k) continue;
      const t = terms.get(k) ?? { sources: new Map(), targets: new Map() };
      t.sources.set(p.src, (t.sources.get(p.src) ?? 0) + 1);
      if (!t.targets.has(p.tgt)) t.targets.set(p.tgt, new Set());
      t.targets.get(p.tgt).add(doc);
      terms.set(k, t);
    }
  }
  const chosen = [];
  const ambiguous = [];
  const rejected = [];
  for (const [, t] of terms) {
    const ranked = [...t.targets].map(([tgt, docs]) => ({ tgt, docs: [...docs] })).sort((a, b) => b.docs.length - a.docs.length);
    const top = ranked[0];
    if (top.docs.length < minDocs) continue;
    const source = [...t.sources].sort((a, b) => a[0].length - b[0].length || b[1] - a[1])[0][0];
    if (ranked[1] && ranked[1].docs.length === top.docs.length) {
      ambiguous.push({ source, targets: ranked.filter((r) => r.docs.length === top.docs.length).map((r) => r.tgt) });
      continue;
    }
    const reason = bootstrapReject(source, top.tgt, titles) ?? screenCandidate({ source, target: top.tgt }, { ignore });
    if (reason) {
      rejected.push({ source, target: top.tgt, reason });
      continue;
    }
    chosen.push({ id: slugOf(source), source, target: top.tgt, docs: top.docs });
  }
  // one rendering must not stand for two source terms: keep the better supported one
  const collisions = [];
  const byTarget = new Map();
  for (const c of chosen.sort((a, b) => b.docs.length - a.docs.length || a.id.localeCompare(b.id))) {
    if (byTarget.has(c.target)) {
      collisions.push({ source: c.source, target: c.target, with: byTarget.get(c.target).source });
      continue;
    }
    byTarget.set(c.target, c);
  }
  const kept = [...byTarget.values()].sort((a, b) => b.docs.length - a.docs.length || a.id.localeCompare(b.id)).slice(0, maxTerms);

  const doNotTranslate = [];
  for (const [src, docs] of names) {
    if (docs.size < minDocs || !/[A-Z]/.test(src)) continue;
    if (screenCandidate({ source: src, doNotTranslate: true }, { ignore })) continue;
    doNotTranslate.push({ term: src, docs: [...docs] });
  }
  for (const s of seeds) if (!doNotTranslate.some((d) => d.term.toLowerCase() === String(s).toLowerCase())) doNotTranslate.push({ term: String(s), docs: [], seed: true });
  doNotTranslate.sort((a, b) => (b.docs?.length ?? 0) - (a.docs?.length ?? 0) || a.term.localeCompare(b.term));
  return { terms: kept, doNotTranslate, ambiguous, rejected, collisions };
}

/** The starter style notes (glossary-and-style.md §5) with the locale's own notes appended. */
export function starterStyle(locale, localeEntry = {}) {
  const lines = [
    `# style.md — ${locale} 风格笔记`, "", "## 起始规则",
    "- 源文档的语气与人称保持一致;技术文档用书面、克制的语气。",
    "- 列表与表格的句末标点跟随源文档。",
    "- `Yes`/`No`、`Enabled`/`Disabled` 等固定状态词在整个站点内统一译法(进术语表)。",
  ];
  if (/^zh/i.test(locale)) lines.push('- 全角标点;中英文与数字之间加一个半角空格;读者称"你",不称"您"。', "- 英文单词、代码、命令、配置键与产品名保持原写法。");
  if (localeEntry.notes) lines.push(`- ${localeEntry.notes}`);
  return `${lines.join("\n")}\n`;
}
