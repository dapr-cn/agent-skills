import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { doc, libUrl, makeSite, read, readJsonFile, sha, statectl, tmpDir, tr, trJson, write } from "./helpers.mjs";

const st = await import(libUrl("state.mjs"));
const { applyRevert, auditGlossary, isKeptInEnglish } = await import(libUrl("glossary.mjs"));

const glossaryFile = (site) => path.join(site.glossaryDir("zh-CN"), "glossary.json");
const pendingFile = (site) => path.join(site.glossaryDir("zh-CN"), "pending.json");
const stateFile = (site, name) => path.join(site.state("zh-CN"), name);
const ledgerOf = (site) => read(stateFile(site, "ledger.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
const changesOf = (site) => read(path.join(site.glossaryDir("zh-CN"), "changes.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
const AUTO = (id, source, target, extra = {}) => ({ id, source, target, alt: [], note: "", origin: "auto", locked: false, confidence: "medium", occurrences: 1, conflicts: [], ...extra });

/** A finished translation recorded the same way `tr finalize` would (statectl doc finalize; termTargets given explicitly). */
function finish(site, rel, zh, termTargets) {
  write(site.content("zh-CN", rel), zh);
  const args = ["doc", "finalize", "--dir", site.state("zh-CN"), "--run", "r1", "--doc", rel, "--source", path.join(site.repo, "docs", rel), "--translation", site.content("zh-CN", rel), "--repo", site.repo];
  if (termTargets) args.push("--term-targets", JSON.stringify(termTargets));
  const f = statectl(...args);
  assert.equal(f.status, 0, f.stderr);
}

/** Glossary with terms in each protection state, two finished translations, and the renderings they recorded. */
function revertSite() {
  const site = makeSite({ sources: { "a.md": doc("A", "Lineage and drain. Open the router."), "b.md": doc("B", "Drain here.") } });
  write(glossaryFile(site), `${JSON.stringify({
    schema: 1, version: 7, updatedAt: null,
    doNotTranslate: [{ term: "OmniRoute", note: "", origin: "bootstrap", locked: false }],
    terms: [
      AUTO("drain", "drain", "排空"),
      AUTO("lineage", "Lineage", "谱系"),
      AUTO("router", "router", "路由器", { origin: "human" }),
      AUTO("sentinel", "sentinel", "哨兵", { locked: true }),
      AUTO("clamp", "clamp", "钳制"),
    ],
  }, null, 2)}\n`);
  finish(site, "a.md", doc("甲", "谱系和排空。打开路由器。"), { drain: "排空", lineage: "谱系", router: "路由器" });
  finish(site, "b.md", doc("乙", "这里排空。"), { drain: "排空" });
  return site;
}

/** Two orphans: gone-drop.md (source and translation gone) and gone-keep.md (source gone, translation still on disk). */
function orphanSite() {
  const site = makeSite({ sources: { "a.md": doc("A", "A."), "gone-drop.md": doc("D", "D."), "gone-keep.md": doc("K", "K.") } });
  finish(site, "a.md", doc("甲", "甲。"));
  finish(site, "gone-drop.md", doc("丁", "丁。"));
  finish(site, "gone-keep.md", doc("戊", "戊。"));
  rmSync(path.join(site.repo, "docs", "gone-drop.md"));
  rmSync(path.join(site.repo, "docs", "gone-keep.md"));
  rmSync(site.content("zh-CN", "gone-drop.md"));
  return site;
}

const revert = (site, ...args) => trJson("glossary", "revert", "--profile", site.profile, ...args);

// ------------------------------------------------------------------------------------------------ pure functions

test("applyRevert --to source: the term keeps its English word and a do-not-translate entry holds it; locked and human terms are skipped", () => {
  const g = { schema: 1, version: 3, doNotTranslate: [], terms: [AUTO("drain", "drain", "排空"), AUTO("router", "router", "路由器", { origin: "human" }), AUTO("sentinel", "sentinel", "哨兵", { locked: true })] };
  const pending = { schema: 1, entries: [{ id: "drain", source: "drain", target: "排水", kind: "term", docs: ["x.md"] }, { id: "drain", source: "drain", target: "dnt", kind: "doNotTranslate", docs: ["y.md"] }] };
  const r = applyRevert(g, pending, { ids: ["drain", "router", "sentinel", "nope"], to: "source", reason: "通用词" });
  assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [["drain", "reverted"], ["router", "skipped"], ["sentinel", "skipped"], ["nope", "not-found"]]);
  assert.deepEqual(r.outcomes.slice(1, 3).map((o) => o.why), ["human", "locked"]);
  const drain = r.glossary.terms.find((t) => t.id === "drain");
  assert.equal(drain.target, "drain");
  assert.match(drain.note, /kept in English: 通用词/);
  assert.deepEqual(r.glossary.doNotTranslate, [{ term: "drain", note: "reverted: 通用词", origin: "human", locked: false }]);
  assert.deepEqual(r.pending.entries.map((e) => [e.kind, e.target]), [["doNotTranslate", "dnt"]], "a pending rendering of the same term is withdrawn; a pending do-not-translate is kept");
  assert.deepEqual(r.withdrawn.map((w) => [w.id, w.target]), [["drain", "排水"]]);
  assert.equal(r.glossary.version, 4);
  assert.equal(r.versionBumps, 1);
  assert.deepEqual(r.changes.map((c) => [c.op, c.id, c.kind, c.to, c.version]), [["revert", "drain", "term", "source", 4], ["revert", "drain", "pending", "withdrawn", 4]]);
  // the input is not mutated
  assert.equal(g.terms[0].target, "排空");
  assert.equal(g.version, 3);
});

test("applyRevert --to source twice: the second run reports already and changes nothing", () => {
  const once = applyRevert({ version: 1, terms: [AUTO("clamp", "clamp", "钳制")], doNotTranslate: [] }, null, { ids: ["clamp"], to: "source" });
  const twice = applyRevert(once.glossary, once.pending, { ids: ["clamp"], to: "source" });
  assert.deepEqual(twice.outcomes, [{ id: "clamp", status: "already", source: "clamp", target: "clamp" }]);
  assert.equal(twice.versionBumps, 0);
  assert.equal(twice.glossary.version, 2, "the version is not bumped when nothing changed");
});

test("applyRevert --to remove deletes the row and adds no do-not-translate entry", () => {
  const r = applyRevert({ version: 1, terms: [AUTO("clamp", "clamp", "钳制"), AUTO("lineage", "Lineage", "谱系")], doNotTranslate: [] }, { entries: [] }, { ids: ["clamp"], to: "remove" });
  assert.deepEqual(r.glossary.terms.map((t) => t.id), ["lineage"]);
  assert.deepEqual(r.glossary.doNotTranslate, []);
  assert.deepEqual(r.outcomes, [{ id: "clamp", status: "removed", source: "clamp", from: "钳制" }]);
});

test("applyRevert rejects an unknown mode; isKeptInEnglish needs both the same word and a do-not-translate entry", () => {
  assert.throws(() => applyRevert({ terms: [] }, null, { ids: ["x"], to: "keep" }), /to must be/);
  const term = AUTO("drain", "drain", "drain");
  assert.equal(isKeptInEnglish(term, { doNotTranslate: [] }), false, "the same word without a do-not-translate entry is an untranslated term, not a decision");
  assert.equal(isKeptInEnglish(term, { doNotTranslate: [{ term: "Drain" }] }), true);
  assert.equal(isKeptInEnglish(AUTO("drain", "drain", "排空"), { doNotTranslate: [{ term: "drain" }] }), false);
});

test("audit keeps a term that was reverted to English, even with no evidence; a plain untranslated term is still removed", () => {
  const g = {
    version: 2, doNotTranslate: [{ term: "clamp", origin: "human", locked: false }],
    terms: [AUTO("clamp", "clamp", "clamp"), AUTO("drain", "drain", "drain")],
  };
  const a = auditGlossary(g, { docs: [], minDocs: 2 });
  assert.deepEqual(a.keep.map((k) => [k.id, k.why]), [["clamp", "kept in English (do-not-translate)"]]);
  assert.deepEqual(a.remove.map((r) => [r.id, r.reason.split(":")[0]]), [["drain", "untranslated"]]);
});

test("replay: a doc_orphan_pruned line removes the record for good", () => {
  const dir = tmpDir();
  st.appendLedger(dir, { event: "doc_done", run: "r1", doc: "a.md", status: "done", sourceSha256: "s", translationSha256: "t" });
  st.appendLedger(dir, { event: "doc_done", run: "r1", doc: "b.md", status: "done", sourceSha256: "s", translationSha256: "t" });
  st.appendLedger(dir, { event: "doc_orphan_pruned", run: "r2", doc: "a.md" });
  assert.deepEqual(Object.keys(st.replayLedger(path.join(dir, "ledger.jsonl")).docs), ["b.md"]);
});

test("pruneOrphans: drops only the named records, rotates the backup and logs one line per document", () => {
  const dir = tmpDir();
  st.writeSnapshot(dir, "r0", JSON.stringify({ schema: 1, docs: { "a.md": { status: "done", sourceSha256: "s" }, "o.md": { status: "failed", translationSha256: "t" } } }));
  const r = st.pruneOrphans({ dir, run: "p1", locale: "zh-CN", entries: [{ doc: "o.md", reason: "gone" }, { doc: "missing.md", reason: "gone" }] });
  assert.deepEqual(r.pruned, ["o.md"]);
  const snap = readJsonFile(path.join(dir, "snapshot.json"));
  assert.deepEqual(Object.keys(snap.docs), ["a.md"]);
  assert.equal(snap.lastRun, "p1");
  assert.equal(readdirSync(path.join(dir, "backup")).length, 1);
  const lines = read(path.join(dir, "ledger.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.event, e.doc, e.status, e.translationSha256]), [["doc_orphan_pruned", "o.md", "failed", "t"]]);
  assert.deepEqual(st.pruneOrphans({ dir, run: "p2", locale: "zh-CN", entries: [{ doc: "o.md", reason: "gone" }] }).pruned, [], "already gone: nothing to do");
});

// ------------------------------------------------------------------------------------------------ glossary revert (CLI)

test("glossary revert --to source --dry-run: reports every outcome and the finished translations that record a reverted term, and writes nothing", () => {
  const site = revertSite();
  const before = sha(glossaryFile(site));
  const r = revert(site, "--to", "source", "--ids", "drain,lineage,router,sentinel,nope,clamp,drain", "--dry-run", "--reason", "通用词", "--run", "rv1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.outcomes.map((o) => [o.id, o.status]), [["drain", "reverted"], ["lineage", "reverted"], ["router", "skipped"], ["sentinel", "skipped"], ["nope", "not-found"], ["clamp", "reverted"]]);
  assert.deepEqual([r.json.dryRun, r.json.applied, r.json.version], [true, false, 8]);
  assert.equal(sha(glossaryFile(site)), before);
  assert.equal(existsSync(pendingFile(site)), false);
  assert.deepEqual(r.json.affected.rows.map((x) => [x.id, x.doc, x.drift]).sort(), [["drain", "a.md", true], ["drain", "b.md", true], ["lineage", "a.md", true]]);
  assert.deepEqual([r.json.affected.documents, r.json.affected.drift], [2, 3]);
  assert.match(tr("glossary", "revert", "--profile", site.profile, "--to", "source", "--ids", "drain", "--dry-run").stdout, /dry run: nothing written \(drop --dry-run to apply\)/);
});

test("glossary revert --to source: the term keeps its English word, the do-not-translate entry holds it; log, ledger and snapshot follow; the finished translations are not rewritten", () => {
  const site = revertSite();
  const r = revert(site, "--to", "source", "--ids", "drain,lineage,clamp", "--reason", "通用词", "--run", "rv1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.applied, r.json.version], [true, 8]);
  const g = readJsonFile(glossaryFile(site));
  assert.equal(g.version, 8);
  const drain = g.terms.find((t) => t.id === "drain");
  assert.deepEqual([drain.source, drain.target, drain.origin], ["drain", "drain", "auto"]);
  assert.deepEqual(g.doNotTranslate.map((n) => n.term).sort(), ["Lineage", "OmniRoute", "clamp", "drain"]);
  assert.equal(g.doNotTranslate.find((n) => n.term === "drain").origin, "human");
  assert.deepEqual(changesOf(site).map((c) => [c.op, c.id, c.to, c.version, c.run]), [["revert", "drain", "source", 8, "rv1"], ["revert", "lineage", "source", 8, "rv1"], ["revert", "clamp", "source", 8, "rv1"]]);
  const ev = ledgerOf(site).filter((e) => e.event === "glossary_change" && e.run === "rv1");
  assert.equal(ev.length, 1);
  assert.match(ev[0].note, /^revert \(source\): 3 changed, 0 already, 0 not found, 0 skipped; 通用词$/);
  const snap = readJsonFile(stateFile(site, "snapshot.json"));
  assert.deepEqual([snap.glossaryVersion, snap.glossarySha256], [8, sha(glossaryFile(site))]);
  assert.equal(snap.docs["a.md"].termTargets.drain, "排空", "the record of the finished translation is left alone");
  assert.equal(read(site.content("zh-CN", "a.md")).includes("谱系"), true, "the translation file is untouched");
  assert.equal(existsSync(stateFile(site, "run.lock")), false);
  // the next scan judges the finished translations that still use the old rendering as drift; nothing is requeued here
  const scan = trJson("scan", "--profile", site.profile).json;
  assert.equal(scan.glossary.changedOutsideRun, false);
  assert.equal(scan.summary.drift, 2);
  assert.equal(scan.summary.stale, 0);
  // the audit no longer proposes these terms for removal or demotion
  const audit = trJson("glossary", "audit", "--profile", site.profile).json;
  assert.deepEqual([audit.remove.length, audit.demote.length], [0, 0]);
  assert.equal(tr("status", "--profile", site.profile, "--fail-on", "glossary").status, 0);
});

test("glossary revert is idempotent: a term already kept in English is reported as already and nothing is written", () => {
  const site = revertSite();
  assert.equal(revert(site, "--to", "source", "--ids", "drain").status, 0);
  const before = sha(glossaryFile(site));
  const again = revert(site, "--to", "source", "--ids", "drain");
  assert.deepEqual([again.json.applied, again.json.version, again.json.outcomes[0].status], [false, 8, "already"]);
  assert.equal(sha(glossaryFile(site)), before);
  assert.match(tr("glossary", "revert", "--profile", site.profile, "--to", "source", "--ids", "drain").stdout, /nothing to change/);
});

test("glossary revert --to remove deletes the row and withdraws its pending renderings; the scan reports no drift for a removed term", () => {
  const site = revertSite();
  write(pendingFile(site), `${JSON.stringify({ schema: 1, entries: [{ id: "clamp", source: "clamp", target: "钳位", kind: "term", note: "", docs: ["a.md"], firstSeen: { run: "r0" }, lastSeen: { run: "r0" } }] }, null, 2)}\n`);
  const r = revert(site, "--to", "remove", "--ids", "clamp,drain", "--run", "rm1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.outcomes.map((o) => [o.id, o.status]), [["clamp", "removed"], ["drain", "removed"]]);
  const g = readJsonFile(glossaryFile(site));
  assert.deepEqual(g.terms.map((t) => t.id), ["lineage", "router", "sentinel"]);
  assert.deepEqual(g.doNotTranslate.map((n) => n.term), ["OmniRoute"], "remove adds no do-not-translate entry");
  assert.deepEqual(readJsonFile(pendingFile(site)).entries, []);
  assert.deepEqual(r.json.withdrawnPending.map((w) => [w.id, w.target]), [["clamp", "钳位"]]);
  assert.deepEqual(changesOf(site).map((c) => [c.id, c.kind, c.to]), [["clamp", "term", "removed"], ["clamp", "pending", "withdrawn"], ["drain", "term", "removed"]]);
  assert.equal(r.json.affected.rows.length, 0, "no reference to a rendering that will drift: the term is gone");
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.drift, 0);
});

test("glossary revert: --ids-from reads one id per line, # starts a comment, blank lines are skipped", () => {
  const site = revertSite();
  const file = write(path.join(tmpDir(), "ids.txt"), "# words kept in English\ndrain\n\nlineage, clamp # two on one line\n");
  const r = revert(site, "--to", "source", "--ids-from", file, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.outcomes.map((o) => o.id), ["drain", "lineage", "clamp"]);
});

test("glossary revert refuses bad input (exit 2), and a busy run lock is exit 3 with nothing written", () => {
  const site = revertSite();
  assert.equal(tr("glossary", "revert", "--profile", site.profile, "--ids", "drain").status, 2, "--to is required");
  assert.equal(tr("glossary", "revert", "--profile", site.profile, "--to", "keep", "--ids", "drain").status, 2);
  assert.equal(tr("glossary", "revert", "--profile", site.profile, "--to", "source").status, 2, "no ids");
  const before = sha(glossaryFile(site));
  write(stateFile(site, "run.lock"), JSON.stringify({ run: "other", startedAt: new Date().toISOString() }));
  const busy = tr("glossary", "revert", "--profile", site.profile, "--to", "source", "--ids", "drain");
  assert.equal(busy.status, 3, busy.stderr);
  assert.equal(sha(glossaryFile(site)), before);
});

// ------------------------------------------------------------------------------------------------ orphan prune (CLI)

const prune = (site, ...args) => trJson("orphan", "prune", "--profile", site.profile, ...args);

test("orphan prune --dry-run: lists what would go and what is kept, and writes nothing", () => {
  const site = orphanSite();
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.orphan, 2);
  const before = sha(stateFile(site, "snapshot.json"));
  const r = prune(site, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.orphans, r.json.prune, r.json.applied], [2, ["gone-drop.md"], false]);
  assert.deepEqual(r.json.kept.map((k) => k.doc), ["gone-keep.md"]);
  assert.equal(sha(stateFile(site, "snapshot.json")), before);
});

test("orphan prune: removes only records whose translation is gone, backs up the snapshot, logs the removal, and leaves files on disk alone", () => {
  const site = orphanSite();
  const backups = () => (existsSync(stateFile(site, "backup")) ? readdirSync(stateFile(site, "backup")).length : 0);
  const before = backups();
  const r = prune(site, "--run", "pr1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.applied, r.json.prune], [true, ["gone-drop.md"]]);
  const snap = readJsonFile(stateFile(site, "snapshot.json"));
  assert.deepEqual(Object.keys(snap.docs).sort(), ["a.md", "gone-keep.md"]);
  assert.equal(snap.lastRun, "pr1");
  assert.ok(backups() > before, "the previous snapshot was kept as a backup");
  assert.deepEqual(ledgerOf(site).filter((e) => e.event === "doc_orphan_pruned").map((e) => [e.run, e.doc, e.status]), [["pr1", "gone-drop.md", "done"]]);
  assert.equal(read(site.content("zh-CN", "gone-keep.md")), doc("戊", "戊。"), "the translation file that is still on disk is untouched");
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.orphan, 1);
  assert.equal(existsSync(stateFile(site, "run.lock")), false);
  // the ledger is history: a rebuild from it must not bring the pruned record back
  assert.deepEqual(Object.keys(st.replayLedger(stateFile(site, "ledger.jsonl")).docs).sort(), ["a.md", "gone-keep.md"]);
  // a second run has nothing left to prune
  const again = prune(site);
  assert.deepEqual([again.json.prune, again.json.kept.map((k) => k.doc), again.json.applied], [[], ["gone-keep.md"], false]);
  assert.match(tr("orphan", "prune", "--profile", site.profile).stdout, /nothing to prune/);
});

test("orphan prune honours --only and --only-from; a busy run lock is exit 3 and the snapshot is untouched", () => {
  const site = orphanSite();
  const none = prune(site, "--only", "nothing/**", "--dry-run");
  assert.deepEqual([none.json.orphans, none.json.prune], [0, []]);
  const drop = prune(site, "--only", "gone-*.md", "--dry-run");
  assert.deepEqual(drop.json.prune, ["gone-drop.md"]);
  const listed = write(path.join(tmpDir(), "only.txt"), "gone-keep.md\n");
  const keep = prune(site, "--only-from", listed, "--dry-run");
  assert.deepEqual([keep.json.orphans, keep.json.prune, keep.json.kept.map((k) => k.doc)], [1, [], ["gone-keep.md"]]);
  const before = sha(stateFile(site, "snapshot.json"));
  write(stateFile(site, "run.lock"), JSON.stringify({ run: "other", startedAt: new Date().toISOString() }));
  assert.equal(tr("orphan", "prune", "--profile", site.profile).status, 3);
  assert.equal(sha(stateFile(site, "snapshot.json")), before);
});

test("orphan without a known subcommand is a usage error", () => {
  const site = orphanSite();
  assert.equal(tr("orphan").status, 2, "no subcommand");
  assert.equal(tr("orphan", "delete", "--profile", site.profile).status, 2);
});
