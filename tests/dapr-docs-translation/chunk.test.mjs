import assert from "node:assert/strict";
import { test } from "node:test";
import { libUrl } from "./helpers.mjs";

const { splitMarkdown, joinChunks } = await import(libUrl("chunk.mjs"));
const para = (n, word = "Lorem ipsum dolor sit amet") => `${Array.from({ length: n }, () => word).join(" ")}.\n`;
const section = (title, bytes) => `## ${title}\n\n${para(Math.ceil(bytes / 27))}\n`;
const rejoin = (chunks) => chunks.map((c) => c.text).join("");

test("a small document is one chunk", () => {
  const text = "# T\n\nhello\n";
  const chunks = splitMarkdown(text, 4096);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, text);
});

test("chunks always reassemble to the exact source and respect the budget", () => {
  const text = `---\ntitle: "T"\n---\n\n# T\n\nintro\n\n${["A", "B", "C", "D", "E", "F"].map((t) => section(t, 1500)).join("")}`;
  const chunks = splitMarkdown(text, 4096);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  assert.equal(rejoin(chunks), text);
  for (const c of chunks) assert.ok(c.bytes <= 4096 + 100, `chunk ${c.index} is ${c.bytes} bytes`);
  for (const c of chunks.slice(1)) assert.match(c.text, /^## /, "later chunks start at a heading");
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
});

test("frontmatter stays in the first chunk and is never cut", () => {
  const fm = `---\ntitle: "T"\n${Array.from({ length: 80 }, (_, i) => `k${i}: value ${i}`).join("\n")}\n---\n\n`;
  const text = `${fm}# T\n\n${section("A", 3000)}${section("B", 3000)}`;
  const chunks = splitMarkdown(text, 2000);
  assert.ok(chunks[0].text.startsWith(fm));
  assert.equal(rejoin(chunks), text);
});

test("headings and blank lines inside a code fence are not cut points", () => {
  const code = `\`\`\`md\n## not a heading\n\n${para(60)}\n## still code\n\n${para(60)}\`\`\`\n`;
  const text = `# T\n\n${section("A", 1200)}${code}\n${section("B", 1200)}`;
  const chunks = splitMarkdown(text, 1500);
  assert.equal(rejoin(chunks), text);
  for (const c of chunks) assert.equal((c.text.match(/^```/gm) ?? []).length % 2, 0, `chunk ${c.index} cuts a fence`);
});

test("a JSX component or <details> block is never split across chunks", () => {
  const block = `<Tabs>\n\n${para(60)}\n## inside heading\n\n${para(60)}\n</Tabs>\n`;
  const text = `# T\n\n${section("A", 1500)}${block}\n${section("B", 1500)}<details>\n\n${para(60)}\n\n${para(60)}\n</details>\n`;
  const chunks = splitMarkdown(text, 1800);
  assert.equal(rejoin(chunks), text);
  for (const c of chunks) {
    const opens = (c.text.match(/<(Tabs|details)>/g) ?? []).length;
    const closes = (c.text.match(/<\/(Tabs|details)>/g) ?? []).length;
    assert.equal(opens, closes, `chunk ${c.index} has unbalanced blocks`);
  }
});

test("an oversize section falls back to paragraph boundaries; a single huge paragraph stays whole", () => {
  const text = `# T\n\n${Array.from({ length: 8 }, () => `${para(40)}\n`).join("")}`;
  const chunks = splitMarkdown(text, 1500);
  assert.ok(chunks.length > 1);
  assert.equal(rejoin(chunks), text);
  const huge = `# T\n\n${para(400)}`;
  const one = splitMarkdown(huge, 500);
  assert.equal(rejoin(one), huge);
  assert.ok(one.some((c) => c.bytes > 500), "the oversize paragraph is kept in one piece");
});

test("chunks carry line ranges and the first heading", () => {
  const text = `# T\n\n${section("Alpha", 2500)}${section("Beta", 2500)}`;
  const chunks = splitMarkdown(text, 3000);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks.at(-1).endLine, text.split("\n").length - 1);
  assert.ok(chunks.some((c) => c.heading === "Beta"));
});

test("joinChunks trims, separates with a blank line and ends with one newline", () => {
  assert.equal(joinChunks(["a\n\n\n", "b  \n", "c"]), "a\n\nb\n\nc\n");
});
