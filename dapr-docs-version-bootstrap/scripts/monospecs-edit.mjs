// Text-level additions to .hagicode/monospecs.yaml. Node built-ins only.
// The file carries comments and hand-written entries, so it is never re-serialized: new entries are appended after the
// existing text, which is kept byte for byte. Existing entries are only read (parsed) to avoid duplicates.
import { parseYaml } from "./lib/yaml.mjs";

/** The `path` of every entry in monospecs text. */
export function entryPaths(text) {
  const doc = parseYaml(text);
  return new Set((Array.isArray(doc?.repositories) ? doc.repositories : []).map((r) => String(r.path ?? "")));
}

/** The two optional entries for a new version, with the URLs of the previous version's entries. */
export function entryBlocks({ version, upstreamUrl, zhUrl }) {
  const up = [
    `- path: "repos/${version}"`,
    `  url: "${upstreamUrl}"`,
    `  displayName: "${version}"`,
    `  branch: "${version}"`,
    "  optional: true",
    "  tags: [ data, upstream, source ]",
    '  status: "active"',
    `  note: "Upstream Dapr docs for ${version}; source documents for the zh data sync (optional)."`,
  ].join("\n");
  const zh = [
    `- path: "repos/${version}_zh"`,
    `  url: "${zhUrl}"`,
    `  displayName: "${version}_zh"`,
    `  branch: "${version}_content"`,
    "  optional: true",
    "  tags: [ data, zh-official ]",
    '  status: "active"',
    `  note: "Chinese translation data for ${version}; written by zh:data:sync (optional)."`,
  ].join("\n");
  return { upstream: up, zh };
}

/**
 * Appends whichever of repos/<version> and repos/<version>_zh are missing. Returns { text, added, present }.
 * When both exist the text is returned unchanged (idempotent). The original text is always a prefix of the result.
 */
export function appendEntries(text, { version, upstreamUrl, zhUrl }) {
  const existing = entryPaths(text);
  const blocks = entryBlocks({ version, upstreamUrl, zhUrl });
  const added = [];
  const pieces = [];
  if (!existing.has(`repos/${version}`)) {
    pieces.push(blocks.upstream);
    added.push(`repos/${version}`);
  }
  if (!existing.has(`repos/${version}_zh`)) {
    pieces.push(blocks.zh);
    added.push(`repos/${version}_zh`);
  }
  if (pieces.length === 0) return { text, added, present: true };
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return { text: `${base}\n${pieces.map((p) => `${p}\n`).join("\n")}`, added, present: false };
}
