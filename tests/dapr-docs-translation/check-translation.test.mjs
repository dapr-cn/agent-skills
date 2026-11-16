import assert from "node:assert/strict";
import { test } from "node:test";
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

test("rejects: broken same-document anchor (built-in slugger, no dependency)", () => {
  const m = verdict(variant("anchor", zh.replace("(#设置)", "(#setup)")));
  assert.ok(m.out.hard.some((h) => h.check === "anchors"));
  assert.ok(!(m.out.soft ?? []).some((x) => x.check === "anchor-check-skipped"));
});

test("anchors: duplicate headings get -1 suffixes, punctuation is dropped", () => {
  const a = write(path.join(dir, "dup.en.md"), "# A\n\n## Setup\n\n## Setup\n\n## What's new?\n\n[x](#setup-1) [y](#whats-new)\n");
  const b = write(path.join(dir, "dup.zh.md"), "# A\n\n## Setup\n\n## Setup\n\n## What's new?\n\n[x](#setup-1) [y](#whats-new)\n");
  assert.equal(node("check-translation.mjs", [a, b]).status, 0);
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

// ---- tolerances taken from the baseline translation convention (profile rules.checks) ----
const code = (body) => `# Code\n\n\`\`\`yaml\n${body}\n\`\`\`\n`;
const codeEn = write(path.join(dir, "code.en.md"), code("spec:\n  # Connection string\n  host: localhost # the host\n  port: 80\n"));
const codeCheck = (body, ...extra) => {
  const r = node("check-translation.mjs", [codeEn, write(path.join(dir, `code-${Math.abs(hash(body))}.md`), code(body)), ...extra]);
  return { status: r.status, out: JSON.parse(r.stdout || "{}") };
};
const hash = (x) => [...x].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

test("--fence-comments translate: comment text may change, code may not", () => {
  const translated = "spec:\n  # 连接字符串\n  host: localhost # 主机\n  port: 80\n";
  assert.equal(codeCheck(translated).status, 1, "verbatim by default");
  assert.equal(codeCheck(translated, "--fence-comments", "translate").status, 0);
  const reducedComments = "spec:\n  host: localhost\n  port: 80\n";
  assert.equal(codeCheck(reducedComments, "--fence-comments", "translate").status, 0, "a dropped comment line is harmless");
  const codeChanged = "spec:\n  # 连接字符串\n  host: example.org # 主机\n  port: 80\n";
  const r = codeCheck(codeChanged, "--fence-comments", "translate");
  assert.equal(r.status, 1);
  assert.match(r.out.hard[0].message, /beyond comment text/);
});

test("--fence-comments translate: URLs with // are code, block comments are comments", () => {
  const a = write(path.join(dir, "u.en.md"), code("url: https://example.org\n/* note\n   more */\nx = 1"));
  const ok = write(path.join(dir, "u.zh.md"), code("url: https://example.org\n/* 说明\n   更多 */\nx = 1"));
  const bad = write(path.join(dir, "u2.zh.md"), code("url: https://example.com\n/* 说明\n   更多 */\nx = 1"));
  assert.equal(node("check-translation.mjs", [a, ok, "--fence-comments", "translate"]).status, 0);
  assert.equal(node("check-translation.mjs", [a, bad, "--fence-comments", "translate"]).status, 1);
});

test("--localized-urls allow: a leading zh locale segment is the same target, other changes are not", () => {
  const src = (u) => `# T\n\nSee [docs](${u}).\n`;
  const e = write(path.join(dir, "l.en.md"), src("https://learn.microsoft.com/dotnet/csharp/x#c-12"));
  const zh = write(path.join(dir, "l.zh.md"), src("https://learn.microsoft.com/zh-cn/dotnet/csharp/x#c-12"));
  const other = write(path.join(dir, "l2.zh.md"), src("https://learn.microsoft.com/zh-cn/dotnet/csharp/y#c-12"));
  const fr = write(path.join(dir, "l3.zh.md"), src("https://learn.microsoft.com/fr-fr/dotnet/csharp/x#c-12"));
  assert.equal(node("check-translation.mjs", [e, zh]).status, 1, "exact by default");
  assert.equal(node("check-translation.mjs", [e, zh, "--localized-urls", "allow"]).status, 0);
  assert.equal(node("check-translation.mjs", [e, other, "--localized-urls", "allow"]).status, 1, "a different path still fails");
  assert.equal(node("check-translation.mjs", [e, fr, "--localized-urls", "allow"]).status, 1, "only zh locales are accepted");
});

const inl = (t) => `# T\n\nSet ${t} here.\n`;
test("--inline-placeholders translate: one-for-one CJK replacement only", () => {
  const e = write(path.join(dir, "i.en.md"), inl("`[HOST NAME]:6379`"));
  const swapped = write(path.join(dir, "i.zh.md"), inl("`[主机名]:6379`"));
  const dropped = write(path.join(dir, "i2.zh.md"), inl("[主机名]:6379"));
  const latin = write(path.join(dir, "i3.zh.md"), inl("`[OTHER NAME]:6379`"));
  assert.equal(node("check-translation.mjs", [e, swapped]).status, 1, "strict by default");
  assert.equal(node("check-translation.mjs", [e, swapped, "--inline-placeholders", "translate"]).status, 0);
  assert.equal(node("check-translation.mjs", [e, dropped, "--inline-placeholders", "translate"]).status, 1, "a lost span still fails");
  assert.equal(node("check-translation.mjs", [e, latin, "--inline-placeholders", "translate"]).status, 1, "a Latin replacement still fails");
});

test("a trailing slash on an external URL is the same link", () => {
  const e = write(path.join(dir, "l.en.md"), "# T\n\nSee [z](https://zipkin.io) and [d](https://a.io/x/).\n");
  const z = write(path.join(dir, "l.zh.md"), "# T\n\n参见 [z](https://zipkin.io/) 与 [d](https://a.io/x/)。\n");
  assert.equal(node("check-translation.mjs", [e, z]).status, 0);
  const other = write(path.join(dir, "l2.zh.md"), "# T\n\n参见 [z](https://zipkin.io/) 与 [d](https://a.io/y/)。\n");
  assert.equal(node("check-translation.mjs", [e, other]).status, 1);
});

test("a stray backtick does not swallow the headings after it", () => {
  const en = write(path.join(dir, "s.en.md"), "# T\n\nUse the ` character.\n\n## One\n\nText.\n\n## Two\n\nSee `x` here.\n");
  const dropped = write(path.join(dir, "s.zh.md"), "# T\n\n使用 ` 字符。\n\n## 一\n\n文字。\n\n见 `x`。\n");
  const r = node("check-translation.mjs", [en, dropped]);
  assert.equal(r.status, 1, "a missing heading is found even though a stray backtick comes before it");
  assert.equal(JSON.parse(r.stdout).hard.some((h) => h.check === "headings"), true);
});
