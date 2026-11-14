import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { libUrl, tmpDir, write } from "./helpers.mjs";

const b = await import(libUrl("bootstrap.mjs"));
const g = await import(libUrl("glossary.mjs"));

const SRC = `---
title: "Guide"
---

# 🚀 Guide A {#guide-a}

Intro with **Fallback** and \`**not bold**\`.

## 1. Providers

| Term | Meaning |
| --- | --- |
| Router | picks one |
| \`code\` | skipped |

\`\`\`md
## not a heading
**not bold either**
\`\`\`

## Setup

**Quick Start** and **API key**.
`;

test("extractSlots: headings (cleaned), table first columns, bold terms, with their sections; code and frontmatter skipped", () => {
  const s = b.extractSlots(SRC);
  assert.deepEqual(s.headings.map((h) => [h.level, h.text]), [[1, "Guide A"], [2, "Providers"], [2, "Setup"]]);
  assert.deepEqual(s.tables.map((t) => [t.sec, t.rows]), [[2, ["Term", "Router", ""]]], "inline code is dropped from cells");
  assert.deepEqual(s.bold.map((x) => [x.sec, x.text]), [[1, "Fallback"], [3, "Quick Start"], [3, "API key"]]);
});

const ZH = SRC.replace("Guide A", "指南 A").replace("Providers", "提供者").replace("Setup", "设置").replace("Term | Meaning", "术语 | 含义").replace("Router | picks one", "路由器 | 选一个").replace("**Fallback**", "**回退**").replace("**Quick Start** and **API key**", "**快速开始** 和 **API 密钥**");

test("alignSlots: aligned documents give a pair for every slot (level-1 headings are titles and are skipped)", () => {
  const r = b.alignSlots(b.extractSlots(SRC), b.extractSlots(ZH));
  assert.deepEqual(r.aligned, ["headings", "tables", "bold"]);
  assert.deepEqual(r.failed, []);
  const pairs = r.pairs.filter((p) => p.src).map((p) => `${p.category}:${p.src}=${p.tgt}`);
  assert.ok(pairs.includes("headings:Providers=提供者"));
  assert.ok(pairs.includes("tables:Router=路由器"));
  assert.ok(pairs.includes("bold:API key=API 密钥"));
  assert.equal(r.pairs.some((p) => p.src === "Guide A"), false);
});

test("alignSlots: a section whose counts differ is dropped on its own; the rest still count", () => {
  const damaged = ZH.replace("**快速开始** 和 **API 密钥**", "**快速开始**"); // one bold term lost in the last section
  const r = b.alignSlots(b.extractSlots(SRC), b.extractSlots(damaged));
  assert.ok(r.aligned.includes("bold"), "the first section's bold term still aligns");
  assert.deepEqual(r.failed, ["bold (1 of 2 sections)"]);
  const bold = r.pairs.filter((p) => p.category === "bold").map((p) => p.src);
  assert.deepEqual(bold, ["Fallback"], "nothing from the mismatched section is forced");
});

test("alignSlots: headings that do not line up make tables and bold all-or-nothing", () => {
  const noHeadings = ZH.replace("## 设置\n", "");
  const r = b.alignSlots(b.extractSlots(SRC), b.extractSlots(noHeadings));
  assert.ok(r.failed.includes("headings"));
  assert.equal(r.pairs.some((p) => p.category === "headings"), false);
});

test("parenPairs: 译名（Original）annotations whose Original is in the source", () => {
  const pairs = b.parenPairs("使用路由器（Router）和断路器（Circuit Breaker）和幽灵（Ghost）。", "The Router and the circuit breaker work.");
  assert.deepEqual(pairs.map((p) => [p.src, p.tgt]), [["Router", "路由器"], ["Circuit Breaker", "断路器"]]);
});

test("normalisePair: usable pairs only", () => {
  const ok = (src, tgt) => b.normalisePair({ src, tgt });
  assert.deepEqual([ok("Router", "路由器").src, ok("Router", "路由器").tgt], ["Router", "路由器"]);
  assert.equal(ok("Router", "路由器（Router）").tgt, "路由器", "the original in parentheses is stripped");
  assert.equal(ok("OpenAI", "OpenAI").tgt, "OpenAI", "a name kept as is");
  assert.equal(ok("路由器", "Router"), null, "source must be Latin");
  assert.equal(ok("Router", "router"), null, "an untranslated rendering that differs is not a rendering");
  assert.equal(ok("one two three four five", "五个词的短语"), null, "too many words");
  assert.equal(ok("Router", "这是一个非常非常非常长的译法不是术语"), null, "a rendering that long is not a term");
  assert.equal(ok("Setup", "设置。").tgt, "设置", "trailing punctuation is dropped");
  assert.equal(ok("", "x"), null);
});

test("matchEvidence: pairs a document with the evidence file sharing the longest path suffix; ties are skipped", () => {
  const root = tmpDir();
  const ev = path.join(root, "i18n/zh-CN");
  for (const f of ["docs/guides/A.md", "docs/guides/B.md", "docs/other/B.md", "README.md", "sub/README.md", "docs/Single.md"]) write(path.join(ev, f), "x");
  const m = b.matchEvidence(["docs/guides/A.md", "docs/guides/B.md", "docs/other/B.md", "README.md", "docs/README.md", "Single.md", "missing.md"], [ev]);
  assert.equal(m.get("docs/guides/A.md"), path.join(ev, "docs/guides/A.md"));
  assert.equal(m.get("docs/guides/B.md"), path.join(ev, "docs/guides/B.md"), "the longer matching suffix wins over the same basename elsewhere");
  assert.equal(m.get("docs/other/B.md"), path.join(ev, "docs/other/B.md"));
  assert.equal(m.has("README.md"), false, "two README.md files tie for a one-segment document");
  assert.equal(m.has("missing.md"), false);
  assert.equal(m.get("Single.md"), path.join(ev, "docs/Single.md"), "a one-segment document matches by name when unique");
  mkdirSync(path.join(root, "empty"), { recursive: true });
  assert.equal(b.matchEvidence(["A.md"], [path.join(root, "empty"), path.join(root, "nope")]).size, 0);
});

const pairsOf = (...rows) => new Map(rows.map(([doc, ...pairs]) => [doc, pairs.map(([src, tgt]) => ({ src, tgt }))]));

test("buildBootstrap: a pair must be agreed by minDocs documents; one document is not enough; each document counts once", () => {
  const out = b.buildBootstrap(pairsOf(["a", ["Router", "路由器"], ["Router", "路由器"], ["Fallback", "回退"]], ["b", ["Router", "路由器"]], ["c", ["Router", "路由器"]]));
  assert.deepEqual(out.terms.map((t) => [t.source, t.target, t.docs.length]), [["Router", "路由器", 3]]);
  assert.equal(b.buildBootstrap(pairsOf(["a", ["Fallback", "回退"]]), { minDocs: 1 }).terms.length, 1);
});

test("buildBootstrap: the better supported rendering wins; a tie is reported, not guessed", () => {
  const win = b.buildBootstrap(pairsOf(["a", ["Router", "路由器"]], ["b", ["Router", "路由器"]], ["c", ["Router", "路由"]]));
  assert.equal(win.terms[0].target, "路由器");
  const tie = b.buildBootstrap(pairsOf(["a", ["Router", "路由器"]], ["b", ["Router", "路由器"]], ["c", ["Router", "路由"]], ["d", ["Router", "路由"]]));
  assert.deepEqual([tie.terms.length, tie.ambiguous[0].source, tie.ambiguous[0].targets.sort()], [0, "Router", ["路由", "路由器"]]);
});

test("buildBootstrap: plural and singular are one term; two sources sharing a rendering keep the better supported one", () => {
  const plural = b.buildBootstrap(pairsOf(["a", ["Provider", "提供者"]], ["b", ["Providers", "提供者"]]));
  assert.deepEqual(plural.terms.map((t) => [t.source, t.docs.length]), [["Provider", 2]]);
  const clash = b.buildBootstrap(pairsOf(["a", ["Agent", "代理"], ["Proxy", "代理"]], ["b", ["Agent", "代理"], ["Proxy", "代理"]], ["c", ["Agent", "代理"]]));
  assert.deepEqual(clash.terms.map((t) => t.source), ["Agent"]);
  assert.deepEqual(clash.collisions.map((c) => [c.source, c.with]), [["Proxy", "Agent"]]);
});

test("buildBootstrap: names kept verbatim become do-not-translate; the profile's seeds are added; maxTerms caps the list", () => {
  const out = b.buildBootstrap(pairsOf(["a", ["OpenAI", "OpenAI"], ["lowercase", "lowercase"], ["Alpha", "甲"], ["Beta", "乙"]], ["b", ["OpenAI", "OpenAI"], ["lowercase", "lowercase"], ["Alpha", "甲"], ["Beta", "乙"]]), { seeds: ["HagiCode"], maxTerms: 1 });
  assert.deepEqual(out.doNotTranslate.map((n) => n.term), ["OpenAI", "HagiCode"]);
  assert.equal(out.doNotTranslate.find((n) => n.term === "HagiCode").seed, true);
  assert.equal(out.terms.length, 1);
});

test("buildBootstrap: bootstrap-only precision rules", () => {
  const two = (src, tgt) => pairsOf(["a", [src, tgt]], ["b", [src, tgt]]);
  const reasonOf = (src, tgt, opts = {}) => b.buildBootstrap(two(src, tgt), opts).rejected[0]?.reason ?? "ACCEPTED";
  assert.match(reasonOf("Free Tiers Guide", "免费层指南", { titles: new Set(["free tiers guide"]) }), /^title/);
  assert.match(reasonOf("before", "之前"), /^lowercase-start/);
  assert.match(reasonOf("VPS", "程 OmniRoute"), /^misaligned/);
  assert.match(reasonOf("Dashboard → Providers", "控制面板 → 提供者"), /^symbol/);
  assert.match(reasonOf("Yes!", "可以"), /^symbol/);
  assert.match(reasonOf("Do not", "请勿"), /^generic/);
  assert.match(reasonOf("Two concurrent long", "两个并发的长"), /^too-long/);
  assert.match(reasonOf("Quick Reference", "快速参考"), /^title/);
  assert.match(reasonOf("Files", "文件"), /^generic/);
  assert.equal(reasonOf("API key", "API 密钥"), "ACCEPTED", "Latin text in the rendering is fine when the source has it");
  assert.equal(reasonOf("Workload", "工作负载"), "ACCEPTED");
});

test("starterStyle: the starter rules, Chinese typography for zh, and the locale's own notes", () => {
  const zh = b.starterStyle("zh-CN", { notes: "读者称你" });
  assert.match(zh, /# style\.md — zh-CN/);
  assert.match(zh, /全角标点/);
  assert.match(zh, /读者称你/);
  assert.doesNotMatch(b.starterStyle("de-DE"), /全角/);
});

// ------------------------------------------------------------------------------------------------ audit

const GL = (terms, doNotTranslate = []) => ({ ...g.emptyGlossary(), version: 4, terms: terms.map((t) => ({ locked: false, conflicts: [], ...t })), doNotTranslate });
const docsFor = (...rows) => rows.map(([doc, source, translation]) => ({ doc, source, translation }));

test("auditGlossary: human and locked entries are never touched; names in CamelCase are not identifiers", () => {
  const out = g.auditGlossary(GL([{ id: "file", source: "file", target: "文件", origin: "human" }, { id: "command", source: "command", target: "命令", origin: "auto", locked: true }], [{ term: "OmniRoute", origin: "bootstrap" }, { term: "OpenAI", origin: "auto" }]), { docs: docsFor(["a.md", "x", "y"]) });
  assert.deepEqual([out.keep.length, out.remove.length, out.demote.length], [2, 0, 0]);
});

test("auditGlossary: entries that were never terms are removed, with the screen's reason", () => {
  const out = g.auditGlossary(GL([{ id: "file", source: "file", target: "文件", origin: "bootstrap" }, { id: "forcedconnectionid", source: "forcedConnectionId", target: "强制连接", origin: "auto" }, { id: "same", source: "Same", target: "same", origin: "auto" }], [{ term: "notes.md", origin: "auto" }, { term: "Docker", origin: "bootstrap" }]), { docs: docsFor(["a.md", "x", "y"]) });
  assert.deepEqual(out.remove.map((r) => [r.id, r.reason.split(":")[0], r.kind]), [["file", "generic", "term"], ["forcedconnectionid", "identifier", "term"], ["same", "untranslated", "term"], ["notes.md", "identifier", "doNotTranslate"]]);
});

test("auditGlossary: an auto term needs evidence in minDocs documents; a bootstrap term does not", () => {
  const terms = [
    { id: "router", source: "router", target: "路由器", origin: "auto" },
    { id: "relay", source: "relay", target: "中继", origin: "auto" },
    { id: "gateway", source: "gateway", target: "网关", origin: "auto" },
    { id: "channel", source: "channel", target: "渠道", origin: "bootstrap" },
  ];
  const docs = docsFor(["a.md", "The router and the relay. A channel.", "路由器和中继。渠道。"], ["b.md", "Another router, one relay.", "又一个路由器和一个转发。"], ["c.md", "No terms here.", "无。"]);
  const out = g.auditGlossary(GL(terms), { docs, minDocs: 2 });
  assert.deepEqual(out.keep.map((k) => k.id), ["router", "channel"], "router is used in 2 documents; channel is bootstrap");
  const relay = out.demote.find((d) => d.id === "relay");
  assert.deepEqual([relay.using, relay.reason.includes("1 of 2")], [["a.md"], true], "b.md renders it differently, so it is not evidence");
  assert.deepEqual(out.demote.find((d) => d.id === "gateway").using, [], "never used anywhere: demoted with no evidence");
  assert.equal(g.auditGlossary(GL(terms), { docs, minDocs: 0 }).demote.length, 0, "minDocs 0 = static rules only");
});

test("auditGlossary: collisions and inconsistent use among kept terms are reported, not changed", () => {
  const terms = [{ id: "agent", source: "agent", target: "代理", origin: "human" }, { id: "proxy", source: "proxy", target: "代理", origin: "human" }, { id: "router", source: "router", target: "路由器", origin: "human" }];
  const out = g.auditGlossary(GL(terms), { docs: docsFor(["a.md", "The router.", "路由。"]) });
  assert.deepEqual(out.notes.find((n) => n.kind === "collision"), { kind: "collision", target: "代理", ids: ["agent", "proxy"] });
  assert.deepEqual(out.notes.find((n) => n.kind === "inconsistent")?.docs, ["a.md"]);
});

test("applyAudit: drops removed and demoted entries, stages the demoted ones with their evidence, one version step", () => {
  const terms = [{ id: "file", source: "file", target: "文件", origin: "bootstrap" }, { id: "relay", source: "relay", target: "中继", origin: "auto", note: "n" }, { id: "router", source: "router", target: "路由器", origin: "human" }];
  const docs = docsFor(["a.md", "The relay.", "中继。"]);
  const audit = g.auditGlossary(GL(terms), { docs, minDocs: 2 });
  const prior = { schema: 1, entries: [{ id: "relay", source: "relay", target: "中继", kind: "term", docs: ["z.md"], firstSeen: { run: "r0" } }] };
  const out = g.applyAudit(GL(terms), prior, audit, { run: "r1" });
  assert.deepEqual(out.glossary.terms.map((t) => t.id), ["router"]);
  assert.equal(out.glossary.version, 5);
  assert.equal(out.versionBumps, 1);
  assert.deepEqual(out.pending.entries.map((e) => [e.id, e.docs]), [["relay", ["z.md", "a.md"]]], "evidence is added to an existing pending entry");
  assert.deepEqual(out.changes.map((c) => [c.op, c.id, c.to, c.version]), [["demote", "file", "removed", 5], ["demote", "relay", "pending", 5]]);
  const none = g.applyAudit(GL([]), null, { remove: [], demote: [] }, { run: "r1" });
  assert.deepEqual([none.versionBumps, none.glossary.version], [0, 4]);
});
