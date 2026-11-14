import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { doc, libUrl, read, readJsonFile, sha, statectl, tmpDir, write } from "./helpers.mjs";

const st = await import(libUrl("state.mjs"));

const ledgerLines = (dir) => read(path.join(dir, "ledger.jsonl")).trim().split("\n").map((l) => JSON.parse(l));

test("lock: exclusive, owner-only release, stale takeover", () => {
  const dir = tmpDir();
  assert.equal(st.acquireLock(dir, "r1").status, "acquired");
  assert.equal(st.acquireLock(dir, "r2").status, "busy");
  st.releaseLock(dir, "r2");
  assert.equal(st.acquireLock(dir, "r3").status, "busy", "a foreign release keeps the lock");
  st.releaseLock(dir, "r1");
  assert.equal(st.acquireLock(dir, "r4").status, "acquired");
  // age it past the limit
  writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ run: "old", startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
  assert.equal(st.acquireLock(dir, "r5", 60).status, "took-over-stale");
  assert.equal(st.acquireLock(dir, "r6", 60).status, "busy");
});

test("lock: an unreadable lock file counts as stale only after the age limit", () => {
  const dir = tmpDir();
  write(path.join(dir, "run.lock"), "garbage");
  // no startedAt: age is NaN → treated as stale so a corrupt lock cannot wedge the run forever
  assert.equal(st.acquireLock(dir, "r1").status, "took-over-stale");
});

test("ledger: validates entries, appends with a timestamp, replays last-known state and survives a torn line", () => {
  const dir = tmpDir();
  assert.throws(() => st.appendLedger(dir, { run: "r" }), /event/);
  assert.throws(() => st.appendLedger(dir, []), /object/);
  st.appendLedger(dir, { event: "doc_start", run: "r1", doc: "a.md" });
  st.appendLedger(dir, { event: "doc_done", run: "r1", doc: "a.md", status: "done", sourceSha256: "s", translationSha256: "t" });
  st.appendLedger(dir, { event: "doc_start", run: "r1", doc: "b.md" });
  st.appendLedger(dir, { event: "doc_adopted", run: "r1", doc: "c.md", sourceSha256: "s", translationSha256: "t" });
  st.appendLedger(dir, { event: "doc_failed", run: "r1", doc: "d.md", status: "blocked" });
  const whole = ledgerLines(dir);
  writeFileSync(path.join(dir, "ledger.jsonl"), `${read(path.join(dir, "ledger.jsonl"))}{"torn`);
  const r = st.replayLedger(path.join(dir, "ledger.jsonl"));
  assert.equal(r.docs["a.md"].status, "done");
  assert.equal(r.docs["b.md"].status, "interrupted");
  assert.equal(r.docs["c.md"].adopted, true);
  assert.equal(r.docs["d.md"].status, "blocked");
  assert.equal(r.skippedLines, 1);
  assert.ok(whole.length === 5 && whole.every((e) => typeof e.ts === "string"));
});

test("snapshot: atomic write keeps only `keep` backups", () => {
  const dir = tmpDir();
  for (let i = 1; i <= 5; i += 1) st.writeSnapshot(dir, `r${i}`, JSON.stringify({ v: i }), 2);
  assert.equal(readJsonFile(path.join(dir, "snapshot.json")).v, 5);
  assert.equal(readdirSync(path.join(dir, "backup")).length, 2);
  assert.equal(existsSync(path.join(dir, "snapshot.json.tmp")), false);
});

test("a ledger with only doc_start lines is a run in progress, not a lost snapshot", () => {
  const dir = tmpDir();
  st.appendLedger(dir, { event: "doc_start", run: "r1", doc: "a.md" });
  assert.equal(st.loadSnapshotChain(dir).source, "none");
  assert.deepEqual([...st.ledgerTail(dir)], [["a.md", { event: "doc_start", run: "r1", starts: 1 }]]);
  st.appendLedger(dir, { event: "doc_start", run: "r2", doc: "a.md" });
  assert.equal(st.ledgerTail(dir).get("a.md").starts, 2, "consecutive unfinished starts are counted");
  st.appendLedger(dir, { event: "doc_failed", run: "r2", doc: "a.md", status: "failed" });
  assert.deepEqual(st.ledgerTail(dir).get("a.md"), { event: "doc_failed", run: "r2", starts: 0 });
  assert.equal(st.loadSnapshotChain(dir).source, "ledger", "once the ledger shows finished work it can rebuild the snapshot");
});

test("lockHeld: only a fresh lock counts", () => {
  const dir = tmpDir();
  assert.equal(st.lockHeld(dir), false);
  st.acquireLock(dir, "r1");
  assert.equal(st.lockHeld(dir), true);
  writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ run: "r1", startedAt: new Date(Date.now() - 9 * 3600_000).toISOString() }));
  assert.equal(st.lockHeld(dir), false);
});

test("snapshot recovery order: snapshot → newest backup → ledger → empty", () => {
  const dir = tmpDir();
  assert.equal(st.loadSnapshotChain(dir).source, "none");
  st.appendLedger(dir, { event: "doc_done", run: "r", doc: "a.md", status: "done", sourceSha256: "s", translationSha256: "t" });
  assert.equal(st.loadSnapshotChain(dir).source, "ledger");
  st.writeSnapshot(dir, "r1", JSON.stringify({ docs: { "a.md": { status: "done" } }, tag: 1 }));
  st.writeSnapshot(dir, "r2", JSON.stringify({ docs: {}, tag: 2 }));
  assert.equal(st.loadSnapshotChain(dir).snapshot.tag, 2);
  writeFileSync(path.join(dir, "snapshot.json"), "{ corrupt");
  const viaBackup = st.loadSnapshotChain(dir);
  assert.ok(viaBackup.source.startsWith("backup:"));
  assert.equal(viaBackup.snapshot.tag, 1);
  assert.equal(viaBackup.snapshot.schema, 1, "missing fields are filled from the empty snapshot");
});

const pair = () => {
  const dir = tmpDir();
  const src = write(path.join(dir, "src/a.md"), doc("A", "English body."));
  const tr = write(path.join(dir, "out/a.md"), doc("甲", "中文正文。"));
  return { dir, state: path.join(dir, "state"), src, tr };
};

test("finalizeDoc: hashes from the files, repo-relative path, base copy, ledger entry, run metadata", () => {
  const { dir, state, src, tr } = pair();
  const out = st.finalizeDoc({ dir: state, run: "r1", doc: "a.md", sourceFile: src, translationFile: tr, repo: dir, locale: "zh-CN", glossaryVersion: 3, glossarySha256: "g", sourceRevision: "abc", model: "haiku", retries: 1, seconds: 4, tokens: { in: 10, out: 5 }, termTargets: { setup: "安装" } });
  assert.equal(out.status, "finalized");
  const snap = readJsonFile(path.join(state, "snapshot.json"));
  const e = snap.docs["a.md"];
  assert.equal(e.sourceSha256, sha(src));
  assert.equal(e.translationSha256, sha(tr));
  assert.equal(e.translationPath, "out/a.md", "recorded relative to the repo, whatever the cwd is");
  assert.deepEqual([e.model, e.retries, e.tokens.out, e.termTargets.setup], ["haiku", 1, 5, "安装"]);
  assert.deepEqual([snap.lastRun, snap.glossaryVersion, snap.glossarySha256, snap.sourceRevision, snap.locale], ["r1", 3, "g", "abc", "zh-CN"]);
  assert.equal(read(st.baseSourcePath(state, "a.md")), read(src), "the translated source is kept for later diffs");
  const last = ledgerLines(state).at(-1);
  assert.deepEqual([last.event, last.model, last.status], ["doc_done", "haiku", "done"]);
});

test("finalizeDoc: refusals and re-finalize semantics", () => {
  const { dir, state, src, tr } = pair();
  assert.throws(() => st.finalizeDoc({ dir: state, run: "r", doc: "a.md", sourceFile: src, translationFile: src, repo: dir }), /identical/);
  assert.throws(() => st.finalizeDoc({ dir: state, run: "r", doc: "a.md", sourceFile: src, translationFile: tr, status: "done", flags: ["x"] }), /done_flagged/);
  assert.throws(() => st.finalizeDoc({ dir: state, run: "r", doc: "a.md", sourceFile: src, translationFile: tr, status: "weird" }), /done or done_flagged/);
  st.finalizeDoc({ dir: state, run: "r1", doc: "a.md", sourceFile: src, translationFile: tr, repo: dir, model: "haiku", status: "done_flagged", flags: ["numbers: x"] });
  const snapFile = path.join(state, "snapshot.json");
  const snap = readJsonFile(snapFile);
  snap.docs["a.md"].reviewedAt = "2026-01-01T00:00:00Z";
  writeFileSync(snapFile, JSON.stringify(snap));
  st.finalizeDoc({ dir: state, run: "r2", doc: "a.md", sourceFile: src, translationFile: tr, repo: dir, keepBase: false });
  const e = readJsonFile(snapFile).docs["a.md"];
  assert.equal(e.reviewedAt, "2026-01-01T00:00:00Z", "review time survives a re-finalize");
  assert.equal(e.model, undefined, "per-run figures do not leak into the next finalize");
  assert.deepEqual(e.flags, []);
  assert.ok(readdirSync(path.join(state, "backup")).length >= 1);
});

test("failDoc: attempts climb and the third failure blocks the document", () => {
  const dir = tmpDir();
  assert.deepEqual(st.failDoc({ dir, run: "r1", doc: "a.md", reason: "bad", sourceSha256: "s" }), { status: "failed", attempts: 1 });
  assert.deepEqual(st.failDoc({ dir, run: "r2", doc: "a.md", reason: "bad" }), { status: "failed", attempts: 2 });
  assert.deepEqual(st.failDoc({ dir, run: "r3", doc: "a.md", reason: "bad" }), { status: "blocked", attempts: 3 });
  const e = readJsonFile(path.join(dir, "snapshot.json")).docs["a.md"];
  assert.deepEqual([e.status, e.note, e.sourceSha256], ["blocked", "bad", "s"]);
  assert.deepEqual(ledgerLines(dir).map((l) => [l.event, l.status]), [["doc_failed", "failed"], ["doc_failed", "failed"], ["doc_failed", "blocked"]]);
});

test("adoptDocs: records the baseline once, leaves existing records alone, one snapshot write", () => {
  const dir = tmpDir();
  st.writeSnapshot(dir, "r0", JSON.stringify({ ...st.emptySnapshot("zh-CN"), docs: { "old.md": { status: "failed", attempts: 1 } } }));
  const backupDir = path.join(dir, "backup");
  const count = () => (existsSync(backupDir) ? readdirSync(backupDir).length : 0);
  const before = count();
  const entries = [
    { doc: "a.md", sourceSha256: "s1", translationSha256: "t1", translationPath: "out/a.md" },
    { doc: "b.md", sourceSha256: "s2", translationSha256: "t2", translationPath: "out/b.md" },
    { doc: "old.md", sourceSha256: "s3", translationSha256: "t3", translationPath: "out/old.md" },
  ];
  const r = st.adoptDocs({ dir, run: "adopt-1", locale: "zh-CN", entries, sourceRevision: "rev", glossaryVersion: 2, glossarySha256: "g" });
  assert.deepEqual(r.adopted, ["a.md", "b.md"]);
  const snap = readJsonFile(path.join(dir, "snapshot.json"));
  assert.equal(snap.docs["a.md"].adopted, true);
  assert.equal(snap.docs["old.md"].status, "failed", "an existing record is never overwritten");
  assert.equal(count(), before + 1, "the whole batch costs one backup");
  assert.deepEqual(ledgerLines(dir).map((l) => [l.event, l.doc]), [["doc_adopted", "a.md"], ["doc_adopted", "b.md"]]);
  assert.deepEqual(st.adoptDocs({ dir, run: "adopt-2", locale: "zh-CN", entries }).adopted, [], "adopting twice is a no-op");
});

test("recordGlossary keeps the snapshot's glossary fields in step", () => {
  const dir = tmpDir();
  st.recordGlossary({ dir, run: "r", locale: "zh-CN", version: 7, sha256: "abc" });
  const snap = readJsonFile(path.join(dir, "snapshot.json"));
  assert.deepEqual([snap.glossaryVersion, snap.glossarySha256], [7, "abc"]);
});

test("statectl CLI: exit codes and the finalize wrapper", () => {
  const { dir, state, src, tr } = pair();
  const ctl = (...a) => statectl(...a, "--dir", state);
  assert.equal(ctl("lock", "acquire", "--run", "r1").status, 0);
  assert.equal(ctl("lock", "acquire", "--run", "r2").status, 3);
  assert.equal(ctl("lock", "release", "--run", "r1").status, 0);
  assert.equal(ctl("snapshot", "load").status, 4, "nothing recoverable");
  assert.equal(ctl("ledger", "append", "--json", "nope").status, 2);
  assert.equal(ctl("ledger", "append", "--json", '{"run":"r"}').status, 2);
  assert.equal(ctl("bogus", "cmd").status, 2);
  assert.equal(ctl("doc", "finalize", "--run", "r").status, 2, "missing --doc");
  const fin = ctl("doc", "finalize", "--run", "r1", "--doc", "a.md", "--source", src, "--translation", tr, "--repo", dir, "--model", "haiku", "--tokens-in", "9", "--term-targets", '{"x":"y"}');
  assert.equal(fin.status, 0, fin.stderr);
  const e = readJsonFile(path.join(state, "snapshot.json")).docs["a.md"];
  assert.deepEqual([e.translationPath, e.model, e.tokens, e.termTargets], ["out/a.md", "haiku", { in: 9, out: 0 }, { x: "y" }]);
  assert.equal(ctl("snapshot", "load").status, 0);
  assert.equal(ctl("doc", "finalize", "--run", "r1", "--doc", "a.md", "--source", src, "--translation", src, "--repo", dir).status, 2, "identical hashes are refused");
  const replay = JSON.parse(ctl("ledger", "replay").stdout);
  assert.equal(replay.docs["a.md"].status, "done");
});
