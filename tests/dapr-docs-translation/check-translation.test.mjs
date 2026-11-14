import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { node, tmpDir, write } from "./helpers.mjs";

const en = `---
title: "Guide"
description: "A guide."
version: 1.0
---

# Guide

See the [setup](#setup) and [docs](../README.md#top). Use \`--flag\` here.

## Setup

| Name | Value |
| --- | --- |
| a | 1 |

\`\`\`bash
echo "hello" # keep
\`\`\`

<details><summary>More</summary>

Text with 3 items.

</details>
`;
const zh = `---
title: "指南"
description: "一份指南。"
version: 1.0
---

# 指南

参见[设置](#设置)和[文档](../README.md#top)。此处使用 \`--flag\`。

## 设置

| 名称 | 值 |
| --- | --- |
| a | 1 |

\`\`\`bash
echo "hello" # keep
\`\`\`

<details><summary>更多</summary>

包含 3 项的文本。

</details>
`;

const dir = tmpDir();
const source = write(path.join(dir, "en.md"), en);
const good = write(path.join(dir, "zh.md"), zh);
let hasSlugger = true;
try {
  createRequire(path.join(process.cwd(), "noop.js")).resolve("github-slugger");
} catch {
  hasSlugger = false;
}
const verdict = (translation, ...extra) => {
  const r = node("check-translation.mjs", [source, translation, ...extra]);
  return { status: r.status, out: JSON.parse(r.stdout || "{}") };
};
const variant = (name, text) => write(path.join(dir, `${name}.md`), text);

test("identity and a good translation pass", () => {
  assert.equal(verdict(source).status, 0);
  const r = verdict(good, "--min-cjk-ratio", "0.2");
  assert.equal(r.status, 0, JSON.stringify(r.out));
});

const mutations = [
  ["changed code block", 'echo "hello" # keep', 'echo "你好" # keep', "code-fence"],
  ["dropped code block", /```bash[\s\S]*?```\n\n/, "", "code-fence"],
  ["translated inline code", "`--flag`", "`--标志`", "inline-code"],
  ["changed link target", "../README.md#top", "../README.zh.md#top", "links"],
  ["heading level", "## 设置", "### 设置", "headings"],
  ["extra table column", "| 名称 | 值 |", "| 名称 | 值 | 多 |", "tables"],
  ["frontmatter value", "version: 1.0", "version: 2.0", "frontmatter"],
  ["html tag removed", "<summary>更多</summary>", "更多", "html"],
];
for (const [name, from, to, check] of mutations) {
  test(`rejects: ${name} (${check})`, () => {
    const m = verdict(variant(name.replace(/\W+/g, "-"), zh.replace(from, to)));
    assert.equal(m.status, 1, JSON.stringify(m.out));
    assert.ok(m.out.hard.some((h) => h.check === check), JSON.stringify(m.out));
  });
}

test("rejects: broken same-document anchor", { skip: !hasSlugger && "github-slugger is not resolvable from the working directory" }, () => {
  const m = verdict(variant("anchor", zh.replace("(#设置)", "(#setup)")));
  assert.ok(m.out.hard.some((h) => h.check === "anchors"));
});

test("rejects CRLF; a changed number is only a soft flag", () => {
  const crlf = verdict(variant("crlf", zh.replace(/\n/g, "\r\n")));
  assert.equal(crlf.status, 1);
  assert.ok(crlf.out.hard.some((h) => h.check === "format"));
  const nums = verdict(variant("nums", zh.replace("3 项", "4 项")));
  assert.equal(nums.status, 0);
  assert.ok(nums.out.soft.some((s) => s.check === "numbers"));
});

test("an unused glossary term is a soft flag", () => {
  const glossary = write(path.join(dir, "glossary.json"), JSON.stringify({ terms: [{ source: "setup", target: "安装" }] }));
  const g = verdict(good, "--glossary", glossary);
  assert.equal(g.status, 0);
  assert.ok(g.out.soft.some((s) => s.check === "glossary"));
});

test("term-collision: one rendering for two source terms that both occur is a soft flag; one occurring alone is not", () => {
  const dir2 = tmpDir();
  const src = write(path.join(dir2, "en.md"), "# Guide\n\nThe agent talks to the proxy.\n");
  const zhOk = write(path.join(dir2, "zh.md"), "# 指南\n\n代理与代理交互。\n");
  const gl = (terms) => write(path.join(dir2, `g${terms.length}.json`), JSON.stringify({ terms }));
  const run = (glossaryFile, source = src) => JSON.parse(node("check-translation.mjs", [source, zhOk, "--glossary", glossaryFile]).stdout);
  const clash = run(gl([{ source: "agent", target: "代理" }, { source: "proxy", target: "代理" }]));
  const hit = clash.soft.find((s) => s.check === "term-collision");
  assert.ok(hit, JSON.stringify(clash));
  assert.match(hit.message, /代理 ← agent \/ proxy/);
  assert.equal(clash.ok, true, "a soft flag never fails the document");
  // distinct renderings: no collision
  assert.equal(run(gl([{ source: "agent", target: "智能体" }, { source: "proxy", target: "代理" }])).soft.some((s) => s.check === "term-collision"), false);
  // the same shared rendering, but only one of the two source words is in this document: no collision
  const only = write(path.join(dir2, "only.md"), "# Guide\n\nThe proxy is on.\n");
  assert.equal(run(gl([{ source: "agent", target: "代理" }, { source: "proxy", target: "代理" }]), only).soft.some((s) => s.check === "term-collision"), false);
  // case and plurals of the same word are one term, not a collision
  assert.equal(run(gl([{ source: "agent", target: "代理" }, { source: "Agent", target: "代理" }])).soft.some((s) => s.check === "term-collision"), false);
});

test("--cjk-punctuation rejects ASCII punctuation next to CJK, and only with the flag", () => {
  const bad = variant("punct", zh.replace("包含 3 项的文本。", "包含 3 项的文本."));
  const r = verdict(bad, "--cjk-punctuation");
  assert.equal(r.status, 1);
  assert.ok(r.out.hard.some((h) => h.check === "cjk-punctuation"));
  assert.equal(verdict(bad).status, 0);
  assert.equal(verdict(good, "--cjk-punctuation").status, 0);
});

test("MDX with imports and JSX components passes", () => {
  const mdxEn = write(path.join(dir, "t.en.mdx"), '---\ntitle: "Tabs"\n---\nimport { Tabs } from "x";\n\n# Tabs\n\n<Tabs>\n  <TabItem label="npm">Run it.</TabItem>\n</Tabs>\n');
  const mdxZh = write(path.join(dir, "t.zh.mdx"), '---\ntitle: "标签页"\n---\nimport { Tabs } from "x";\n\n# 标签页\n\n<Tabs>\n  <TabItem label="npm">运行它。</TabItem>\n</Tabs>\n');
  const r = node("check-translation.mjs", [mdxEn, mdxZh, "--translatable", "title"]);
  assert.equal(r.status, 0, r.stdout);
});

test("usage errors exit 2", () => {
  assert.equal(node("check-translation.mjs", [source]).status, 2);
  assert.equal(node("check-translation.mjs", [source, path.join(dir, "missing.md")]).status, 2);
});
