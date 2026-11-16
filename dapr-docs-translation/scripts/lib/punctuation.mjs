// CJK punctuation repair: the deterministic counterpart of check-translation.mjs --cjk-punctuation. An ASCII , . : ; ! ? ( )
// right next to CJK text becomes its full-width form. Code (fenced and inline), link targets, HTML tags and bare URLs are
// never touched. Marks that cannot be converted without guessing (a "." inside a file name, a ":" before a port) are left
// and reported. Node built-ins only.
import { bodyLines } from "./anchors.mjs";

const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af";
const FULL = { ",": "，", ".": "。", ":": "：", ";": "；", "!": "！", "?": "？", "(": "（", ")": "）" };
const CODE = "\u0001";
const OTHER = "\u0002";

/** The line with everything that must not change replaced by placeholder characters of the same length. */
function mask(line) {
  const chars = line.split("");
  const cover = (from, to, ch) => {
    for (let i = from; i < to; i += 1) chars[i] = ch;
  };
  const text = chars.join("");
  for (const m of text.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) cover(m.index, m.index + m[0].length, CODE);
  const current = () => chars.join("");
  // link targets may contain balanced parentheses: [x](https://a.org/f(1).md)
  for (const m of current().matchAll(/\]\(/g)) {
    let depth = 0;
    for (let i = m.index + 1; i < chars.length; i += 1) {
      if (chars[i] === "(") depth += 1;
      else if (chars[i] === ")" && --depth === 0) {
        cover(m.index + 1, i + 1, OTHER);
        break;
      }
    }
  }
  for (const m of current().matchAll(/<[^>\n]+>/g)) cover(m.index, m.index + m[0].length, OTHER);
  for (const m of current().matchAll(/https?:\/\/[^\s)>\]]+/g)) cover(m.index, m.index + m[0].length, OTHER);
  return chars.join("");
}

const PATTERNS = [
  new RegExp(`[${CJK}]([,.:;!?])`, "gd"),
  new RegExp(`[${CJK}](\\()`, "gd"),
  new RegExp(`(\\))[${CJK}]`, "gd"),
  new RegExp(`${CODE}([,;:!?])(?=\\s*[${CJK}])`, "gd"),
];

/** Offsets of the ASCII marks the checker would flag on one masked line. */
function flagged(masked) {
  const found = new Set();
  for (const re of PATTERNS) for (const m of masked.matchAll(re)) found.add(m.indices[1][0]);
  return [...found].sort((a, b) => a - b);
}

function partner(masked, at) {
  if (masked[at] === "(") {
    for (let depth = 0, i = at; i < masked.length; i += 1) {
      if (masked[i] === "(") depth += 1;
      else if (masked[i] === ")" && --depth === 0) return i;
    }
  } else {
    for (let depth = 0, i = at; i >= 0; i -= 1) {
      if (masked[i] === ")") depth += 1;
      else if (masked[i] === "(" && --depth === 0) return i;
    }
  }
  return -1;
}

/** Can this mark be converted without guessing? "." only ends a sentence; the others also may precede CJK or a code span. */
function convertible(masked, at) {
  const ch = masked[at];
  const next = masked[at + 1];
  if (ch === "(" || ch === ")") return true;
  if (ch === ".") return next === undefined || /\s/.test(next);
  return next === undefined || /\s/.test(next) || new RegExp(`[${CJK}${CODE}]`).test(next);
}

/** → { text, fixes: [{line, from, to}], unresolved: [{line, mark, context}] }. Line numbers are 1-based. */
export function fixPunctuation(text) {
  // loose fences: a block nested in a list item can be indented by four or more spaces, and its comments are code
  const { lines, body } = bodyLines(text, { loose: true });
  const fixes = [];
  const unresolved = [];
  for (const { index, line, code } of body) {
    if (code) continue;
    const masked = mask(line);
    const marks = flagged(masked);
    if (!marks.length) continue;
    const chars = line.split("");
    const todo = new Set();
    for (const at of marks) {
      if (!convertible(masked, at)) {
        unresolved.push({ line: index + 1, mark: line[at], context: line.slice(Math.max(0, at - 6), at + 7) });
        continue;
      }
      todo.add(at);
      if (line[at] === "(" || line[at] === ")") {
        const other = partner(masked, at);
        if (other >= 0) todo.add(other);
      }
    }
    // a mark right after a converted ")" belongs to the same clause: （文档）:它 → （文档）：它
    for (const at of [...todo]) {
      if (line[at] === ")" && /[,.:;!?]/.test(masked[at + 1] ?? "") && convertible(masked, at + 1)) todo.add(at + 1);
    }
    for (const at of [...todo].sort((a, b) => a - b)) {
      fixes.push({ line: index + 1, from: chars[at], to: FULL[chars[at]] });
      chars[at] = FULL[chars[at]];
    }
    lines[index] = chars.join("");
  }
  return { text: lines.join("\n"), fixes, unresolved };
}
