import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { doc, libUrl, makeSite, read, readJsonFile, statectl, tmpDir, tr, trJson, write } from "./helpers.mjs";

const { oldRenderingInUse, revertedRenderings } = await import(libUrl("core.mjs"));

const glossaryFile = (site) => path.join(site.glossaryDir("zh-CN"), "glossary.json");
const stateFile = (site, name) => path.join(site.state("zh-CN"), name);
const snapshotOf = (site) => readJsonFile(stateFile(site, "snapshot.json"));
const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
const CHECKPOINT = { id: "checkpoint", source: "checkpoint", target: "检查点", alt: [], note: "", origin: "auto", locked: false, confidence: "medium", occurrences: 2, conflicts: [] };

/** A finished translation recorded without termTargets, the way an adopted or older baseline looks. */
function finish(site, rel, zh) {
  write(site.content("zh-CN", rel), zh);
  const f = statectl("doc", "finalize", "--dir", site.state("zh-CN"), "--run", "r1", "--doc", rel, "--source", path.join(site.repo, "docs", rel), "--translation", site.content("zh-CN", rel), "--repo", site.repo);
  assert.equal(f.status, 0, f.stderr);
}

/**
 * a.md uses the term; b.md has the old word but its source never uses the term (ordinary sense); c.md is an adopted baseline
 * with no termTargets at all. The glossary still says 检查点 until the revert in each test.
 */
function site({ aText = "每个检查点都会被保存。\n" } = {}) {
  const s = makeSite({ sources: { "a.md": doc("A", "Each checkpoint is saved.\n"), "b.md": doc("B", "Nothing to see here.\n"), "c.md": doc("C", "A checkpoint again.\n") } });
  write(glossaryFile(s), json({ schema: 1, version: 5, doNotTranslate: [], terms: [CHECKPOINT] }));
  finish(s, "a.md", doc("甲", aText));
  finish(s, "b.md", doc("乙", "这里没有检查点。\n"));
  write(s.content("zh-CN", "c.md"), doc("丙", "这里有一个检查点。\n"));
  assert.equal(trJson("adopt", "--profile", s.profile).status, 0);
  return s;
}

const revertCheckpoint = (s) => {
  const r = trJson("glossary", "revert", "--profile", s.profile, "--to", "source", "--ids", "checkpoint", "--reason", "通用词");
  assert.equal(r.status, 0, r.stderr);
};
const pendingOf = (scan) => Object.fromEntries(scan.pending.map((p) => [p.doc, p]));
const scanOf = (s) => trJson("scan", "--profile", s.profile).json;

// ------------------------------------------------------------------------------------------------ detection

test("after a revert to English, finished translations that still show the old rendering are drift when the source uses the term; the rest are not", () => {
  const s = site();
  assert.equal(scanOf(s).summary.drift, 0, "before the revert nothing is drift");
  revertCheckpoint(s);
  const scan = scanOf(s);
  assert.equal(scan.summary.drift, 2, "a.md (recorded by finalize) and c.md (adopted baseline, no termTargets)");
  const p = pendingOf(scan);
  assert.equal(p["a.md"].class, "drift");
  assert.match(p["a.md"].reason, /checkpoint: 检查点 → checkpoint/);
  assert.equal(p["c.md"].class, "drift", "a document with no termTargets record is still judged");
  assert.equal(p["b.md"], undefined, "b.md keeps the old word in an ordinary sense: its source never uses the term, so it stays fresh");
  assert.equal(scan.summary.fresh, 1);
});

test("a hand-edited translation that still shows the old rendering stays edited: it is never rewritten by a repair", () => {
  const s = site();
  revertCheckpoint(s);
  write(s.content("zh-CN", "a.md"), `${read(s.content("zh-CN", "a.md"))}\n人工补充。\n`);
  const scan = scanOf(s);
  assert.equal(pendingOf(scan)["a.md"], undefined);
  assert.equal(scan.summary.edited, 1);
  assert.equal(scan.summary.drift, 1, "only the untouched c.md");
});

// ------------------------------------------------------------------------------------------------ repair and clearing

test("next gives a terms-only job for a drift document; its instructions say to keep ordinary senses and list them", () => {
  const s = site();
  revertCheckpoint(s);
  const out = tmpDir("dt-rd-");
  const n = trJson("next", "--profile", s.profile, "--out-dir", out, "--doc", "a.md", "--run", "r2");
  assert.equal(n.status, 0, n.stderr + n.stdout);
  const j = readJsonFile(n.json.jobs[0].job);
  assert.equal(j.mode, "terms-only");
  assert.deepEqual(j.driftTerms, [{ id: "checkpoint", old: "检查点", new: "checkpoint" }]);
  const text = j.instructions.join("\n");
  assert.match(text, /Ordinary senses stay/);
  assert.match(text, /keptTerms/);
  assert.match(text, /termCandidates must be \[\]/);
  assert.match(text, /#fragment/, "same-document anchors follow a changed heading");
  assert.equal(j.previous.translation, s.content("zh-CN", "a.md"));
});

test("a terms-only repair clears the drift: the record is the English word, the reviewed rendering is kept, and the document is fresh", () => {
  const s = site();
  revertCheckpoint(s);
  const n = trJson("next", "--profile", s.profile, "--out-dir", tmpDir("dt-rd-"), "--doc", "a.md", "--run", "r2");
  const job = n.json.jobs[0].job;
  const j = readJsonFile(job);
  write(j.output.draft, doc("甲", "每个 checkpoint 都会被保存。"));
  const f = tr("finalize", "--profile", s.profile, "--job", job);
  assert.equal(f.status, 0, f.stderr);
  const e = snapshotOf(s).docs["a.md"];
  assert.deepEqual([e.status, e.reviewedTerms, e.termTargets], ["done", { checkpoint: "检查点" }, { checkpoint: "checkpoint" }]);
  assert.equal(trJson("scan", "--profile", s.profile).json.pending.find((p) => p.doc === "a.md"), undefined, "a.md is no longer pending");
});

test("a terms-only repair keeps an ordinary occurrence and does not judge it again: no loop", () => {
  const s = site({ aText: "每个检查点都会被保存。另一个检查点只是普通的词。\n" });
  revertCheckpoint(s);
  assert.equal(pendingOf(scanOf(s))["a.md"].class, "drift");
  const n = trJson("next", "--profile", s.profile, "--out-dir", tmpDir("dt-rd-"), "--doc", "a.md", "--run", "r2");
  const job = n.json.jobs[0].job;
  write(readJsonFile(job).output.draft, doc("甲", "每个 checkpoint 都会被保存。另一个检查点只是普通的词。"));
  const f = tr("finalize", "--profile", s.profile, "--job", job, "--flags", "[]");
  assert.equal(f.status, 0, f.stderr);
  const scan = scanOf(s);
  assert.equal(pendingOf(scan)["a.md"], undefined, "the ordinary 检查点 left in the text does not make a.md drift again");
  assert.equal(snapshotOf(s).docs["a.md"].reviewedTerms.checkpoint, "检查点");
});

test("a retranslation (not a terms-only repair) drops the reviewed record; it is judged again on the next scan", () => {
  const s = site({ aText: "每个检查点都会被保存。另一个检查点只是普通的词。\n" });
  revertCheckpoint(s);
  const job = trJson("next", "--profile", s.profile, "--out-dir", tmpDir("dt-rd-"), "--doc", "a.md", "--run", "r2").json.jobs[0].job;
  write(readJsonFile(job).output.draft, doc("甲", "每个 checkpoint 都会被保存。另一个检查点只是普通的词。"));
  assert.equal(tr("finalize", "--profile", s.profile, "--job", job, "--flags", "[]").status, 0);
  assert.equal(snapshotOf(s).docs["a.md"].reviewedTerms.checkpoint, "检查点");
  // the source changes: a full retranslation is written without the review record
  s.src("a.md", doc("A", "Each checkpoint is saved, twice.\n"));
  const again = trJson("next", "--profile", s.profile, "--out-dir", tmpDir("dt-rd-"), "--doc", "a.md", "--run", "r3").json.jobs[0].job;
  write(readJsonFile(again).output.draft, doc("甲", "每个 checkpoint 都会被保存两次。另一个检查点只是普通的词。"));
  assert.equal(tr("finalize", "--profile", s.profile, "--job", again, "--flags", "[]").status, 0);
  assert.equal(snapshotOf(s).docs["a.md"].reviewedTerms, undefined);
});

// ------------------------------------------------------------------------------------------------ failures

test("a failed terms-only repair stays drift and is repeated as terms-only, never as a full retranslation; the third failure blocks it", () => {
  const s = site();
  revertCheckpoint(s);
  const job = trJson("next", "--profile", s.profile, "--out-dir", tmpDir("dt-rd-"), "--doc", "a.md", "--run", "r2").json.jobs[0].job;
  assert.equal(tr("fail", "--job", job, "--reason", "draft does not pass").status, 0);
  assert.equal(snapshotOf(s).docs["a.md"].status, "drift");
  let next = trJson("next", "--profile", s.profile, "--out-dir", tmpDir("dt-rd-"), "--doc", "a.md", "--run", "r3");
  assert.equal(next.status, 0, next.stderr + next.stdout);
  assert.equal(readJsonFile(next.json.jobs[0].job).mode, "terms-only");
  assert.equal(tr("fail", "--job", next.json.jobs[0].job, "--reason", "again").status, 0);
  assert.equal(snapshotOf(s).docs["a.md"].status, "blocked");
  assert.equal(scanOf(s).attention.find((a) => a.doc === "a.md").class, "blocked", "blocked documents are listed for a person, not pending");
});

// ------------------------------------------------------------------------------------------------ pure helpers

test("revertedRenderings: only term reverts to source count, and the latest one wins", () => {
  const dir = tmpDir("dt-cj-");
  const rows = [
    { op: "revert", id: "checkpoint", kind: "term", from: "检查点", target: "checkpoint", to: "source" },
    { op: "revert", id: "retry-policy", kind: "term", from: "重试策略", target: null, to: "removed" },
    { op: "revert", id: "topic", kind: "pending", from: "主题", target: null, to: "withdrawn" },
    { op: "revert", id: "checkpoint", kind: "term", from: "检查点2", target: "checkpoint", to: "source" },
    { op: "add", id: "drain", kind: "term", target: "排空" },
  ];
  writeFileSync(path.join(dir, "changes.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`);
  assert.deepEqual([...revertedRenderings(dir)], [["checkpoint", "检查点2"]]);
  assert.deepEqual([...revertedRenderings(path.join(dir, "missing"))], []);
});

test("oldRenderingInUse: needs the old rendering in the text and the term in the source prose; a recorded review or code-only use does not count", () => {
  const term = { source: "topic" };
  assert.equal(oldRenderingInUse({ id: "topic", old: "主题", snap: {}, text: "使用一个主题。", sourceText: "Use a topic.", term }), true);
  assert.equal(oldRenderingInUse({ id: "topic", old: "主题", snap: {}, text: "页面的主题。", sourceText: "A theme of the page.", term }), false, "the source has no topic: ordinary sense");
  assert.equal(oldRenderingInUse({ id: "topic", old: "主题", snap: { reviewedTerms: { topic: "主题" } }, text: "使用一个主题。", sourceText: "Use a topic.", term }), false, "already reviewed");
  assert.equal(oldRenderingInUse({ id: "topic", old: "主题", snap: {}, text: "使用一个主题。", sourceText: "```\ntopic\n```\nNo prose.", term }), false, "code is not prose");
  assert.equal(oldRenderingInUse({ id: "topic", old: "主题", snap: {}, text: "使用一个主题。", sourceText: null, term }), false, "no source: not judged");
});

test("a long drift document is repaired as one draft: its terms-only job is not split into chunks", () => {
  const filler = "这是填充文字。".repeat(1800);
  const s = makeSite({ sources: { "big.md": doc("Big", `Each checkpoint is saved.\n\n${"Lorem ipsum dolor sit amet. ".repeat(600)}\n`) } });
  write(glossaryFile(s), json({ schema: 1, version: 5, doNotTranslate: [], terms: [CHECKPOINT] }));
  finish(s, "big.md", doc("大", `每个检查点都会被保存。\n\n${filler}\n`));
  revertCheckpoint(s);
  const n = trJson("next", "--profile", s.profile, "--out-dir", tmpDir("dt-rd-"), "--doc", "big.md", "--run", "r2");
  assert.equal(n.status, 0, n.stderr + n.stdout);
  const j = readJsonFile(n.json.jobs[0].job);
  assert.equal(j.mode, "terms-only");
  assert.equal(j.chunks, null, "no chunks: the subagent edits output.draft");
  assert.match(j.instructions.join("\n"), /output\.draft/);
});

test("termRegExp matches the plural of a consonant+y term, not of a vowel+y one", async () => {
  const { termRegExp } = await import(libUrl("jobs.mjs"));
  const retry = termRegExp("retry policy");
  assert.ok(retry.test("Retry policies only impact the handshake."));
  assert.ok(retry.test("a retry policy applies"));
  assert.ok(termRegExp("retry").test("retries are bounded"));
  assert.ok(termRegExp("topic").test("the topics list"));
  assert.ok(!termRegExp("topic").test("topical"));
  assert.ok(termRegExp("key").test("two keys"));
  assert.ok(!termRegExp("key").test("keies"));
});
