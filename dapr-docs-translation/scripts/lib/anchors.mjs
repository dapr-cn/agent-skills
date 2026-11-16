// Same-document anchors: heading slugs (a dependency-free equivalent of github-slugger, which is also what Hugo's
// Goldmark uses for heading ids) and the repair that retargets `#english-slug` links to the translated heading.
// Node built-ins only.

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
// a fence nested in a list item may be indented by any amount
const LOOSE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const LOOSE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/** Split a document into lines outside the front matter, marking which lines are inside fenced code. */
export function bodyLines(text, { loose = false } = {}) {
  const [fenceOpen, fenceClose] = loose ? [LOOSE_OPEN, LOOSE_CLOSE] : [FENCE_OPEN, FENCE_CLOSE];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) start = end + 1;
  }
  const out = [];
  let open = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (open) {
      const m = fenceClose.exec(line);
      if (m && m[1][0] === open.char && m[1].length >= open.len) open = null;
      out.push({ index: i, line, code: true });
      continue;
    }
    const m = fenceOpen.exec(line);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { char: m[1][0], len: m[1].length };
      out.push({ index: i, line, code: true });
    } else out.push({ index: i, line, code: false });
  }
  return { lines, body: out };
}

/** The visible text of a heading: markup characters removed, link text kept, HTML tags dropped. */
export function headingText(raw) {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`/g, "")
    .replace(/\*+/g, "")
    .replace(/(^|\s)__([^_]+)__(?=\s|$)/g, "$1$2")
    .trim();
}

/** Headings outside fenced code: [{level, text}] in document order. */
export function headingList(text) {
  const out = [];
  for (const { line, code } of bodyLines(text).body) {
    if (code) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1].length, text: headingText(h[2]) });
  }
  return out;
}

export function slugBase(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** Slugs in document order; a repeated slug gets -1, -2 … */
export function slugList(headings) {
  const seen = new Map();
  return headings.map((h) => {
    const base = slugBase(h.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  });
}

export const decodeFragment = (t) => {
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
};

const LINK = /(\]\(\s*<?#)([^)\s>]*)(>?\s*\))/g;
const REF_DEF = /^(\s{0,3}\[[^\]]+\]:\s*<?#)(\S+?)(>?\s*)$/;

/**
 * Retarget same-document links of a translation. A fragment is rewritten only when it names a heading of the source,
 * no longer names a heading of the translation, and the headings correspond one to one (same level sequence): the
 * heading at the same position in the translation supplies the new slug.
 * Returns {text, fixes:[{line, from, to}], unresolved:[{line, fragment}], skipped: null | reason}.
 */
export function fixAnchors(sourceText, translationText) {
  const sh = headingList(sourceText);
  const th = headingList(translationText);
  const none = { text: translationText, fixes: [], unresolved: [], skipped: null };
  if (sh.map((h) => h.level).join(",") !== th.map((h) => h.level).join(",")) return { ...none, skipped: `heading structure differs (${sh.length} vs ${th.length} headings)` };
  const srcSlugs = slugList(sh);
  const dstSlugs = slugList(th);
  const dstSet = new Set(dstSlugs);
  const toNew = new Map();
  srcSlugs.forEach((s, i) => toNew.set(s, dstSlugs[i]));
  const fixes = [];
  const unresolved = [];
  const { lines, body } = bodyLines(translationText);
  const resolve = (fragment, lineNo) => {
    const key = decodeFragment(fragment).toLowerCase();
    if (dstSet.has(key) || dstSet.has(fragment)) return fragment; // already resolves
    const next = toNew.get(key) ?? toNew.get(fragment);
    if (next === undefined) {
      unresolved.push({ line: lineNo, fragment });
      return fragment;
    }
    if (next === key) return fragment;
    fixes.push({ line: lineNo, from: fragment, to: next });
    return next;
  };
  for (const { index, line, code } of body) {
    if (code) continue;
    const ref = REF_DEF.exec(line);
    if (ref) {
      lines[index] = `${ref[1]}${resolve(ref[2], index + 1)}${ref[3]}`;
      continue;
    }
    // leave inline code spans alone
    lines[index] = line.split(/(`+[^`]*`+)/).map((part, k) => (k % 2 ? part : part.replace(LINK, (_, a, frag, z) => `${a}${resolve(frag, index + 1)}${z}`))).join("");
  }
  return { text: lines.join("\n"), fixes, unresolved, skipped: null };
}
