// Split a Markdown/MDX document into chunks a small model can translate reliably.
// Guarantee: chunks.map(c => c.text).join("") === text. Cuts only land on line boundaries and never inside frontmatter,
// a fenced code block, or an open JSX component / <details> block. Preferred cut points are level-1/2 headings, then
// paragraph boundaries; one oversize paragraph or code block stays whole rather than being cut.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TAG = /<(\/?)([A-Z][\w.]*|details)\b[^>]*?(\/?)>/g;

function scan(lines) {
  // For each line index: may a chunk start here (heading / paragraph), given fence, frontmatter and JSX state?
  const heading = new Set();
  const paragraph = new Set();
  let i = 0;
  if (lines[0]?.trimEnd() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trimEnd() !== "---") i += 1;
    i += 1; // the closing line belongs to the frontmatter
  }
  let fence = null;
  let depth = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      if (depth === 0 && i > 0 && lines[i - 1].trim() === "") paragraph.add(i);
      fence = f[1];
      continue;
    }
    if (depth === 0 && i > 0) {
      if (/^#{1,2}\s/.test(line)) heading.add(i);
      else if (line.trim() !== "" && lines[i - 1].trim() === "") paragraph.add(i);
    }
    for (const m of line.matchAll(TAG)) {
      if (m[3] === "/") continue; // self-closing
      depth = Math.max(0, depth + (m[1] === "/" ? -1 : 1));
    }
  }
  return { heading, paragraph };
}

const bytesOf = (lines, lo, hi) => Buffer.byteLength(lines.slice(lo, hi).join(""));

/** Greedy packing of [lo,hi) at the given break points; returns ranges. */
function pack(lines, lo, hi, points, max) {
  const cuts = [lo, ...[...points].filter((p) => p > lo && p < hi).sort((a, b) => a - b), hi];
  const ranges = [];
  let start = lo;
  for (let k = 1; k < cuts.length; k += 1) {
    const end = cuts[k];
    if (end === hi) break;
    // would extending the current chunk up to the next cut exceed the budget?
    if (bytesOf(lines, start, cuts[k + 1] ?? hi) > max && cuts[k] > start) {
      ranges.push([start, cuts[k]]);
      start = cuts[k];
    }
  }
  ranges.push([start, hi]);
  return ranges;
}

export function splitMarkdown(text, maxBytes = 6144) {
  const lines = text.split(/(?<=\n)/);
  if (lines.length === 0 || Buffer.byteLength(text) <= maxBytes) return [mk(lines, 0, lines.length, 0)];
  const { heading, paragraph } = scan(lines);
  let ranges = pack(lines, 0, lines.length, heading, maxBytes);
  // sections that are still too large get cut again at paragraph boundaries
  ranges = ranges.flatMap(([lo, hi]) => (bytesOf(lines, lo, hi) > maxBytes ? pack(lines, lo, hi, paragraph, maxBytes) : [[lo, hi]]));
  return ranges.map(([lo, hi], index) => mk(lines, lo, hi, index));
}

function mk(lines, lo, hi, index) {
  const body = lines.slice(lo, hi);
  const h = body.find((l) => /^#{1,6}\s/.test(l));
  return { index, startLine: lo + 1, endLine: hi, bytes: Buffer.byteLength(body.join("")), heading: h ? h.replace(/^#+\s*/, "").trim() : null, text: body.join("") };
}

/** Join translated chunks back into one document: trailing whitespace trimmed, a blank line between chunks, one final newline. */
export function joinChunks(parts) {
  return `${parts.map((p) => p.replace(/\s+$/, "")).join("\n\n")}\n`;
}
