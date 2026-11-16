// Durable-state primitives shared by statectl.mjs and tr.mjs. Node built-ins only.
// Rules (references/state-and-recovery.md §4): the ledger is append-only; the snapshot is replaced atomically after a backup;
// hashes are computed from files here, never typed by hand.
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import path from "node:path";

export const sha256 = (bufferOrText) => createHash("sha256").update(bufferOrText).digest("hex");
export const sha256File = (p) => sha256(readFileSync(p));
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const validJson = (p) => {
  try {
    readJson(p);
    return true;
  } catch {
    return false;
  }
};

export const emptySnapshot = (locale = null) => ({ schema: 1, locale, updatedAt: null, lastRun: null, sourceRevision: null, glossaryVersion: null, glossarySha256: null, docs: {} });

// ------------------------------------------------------------------------------------------------ lock

/** Age-only lock (each tool call may run in a fresh shell, so a PID proves nothing). Returns {status:"acquired"|"took-over-stale"|"busy"}. */
export function acquireLock(dir, run, maxMinutes = 270) {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "run.lock");
  let status = "acquired";
  if (existsSync(lock)) {
    let holder;
    try {
      holder = readJson(lock);
    } catch {
      holder = {};
    }
    const age = Date.now() - Date.parse(holder.startedAt ?? 0);
    if (Number.isFinite(age) && age < maxMinutes * 60_000) return { status: "busy", holder };
    rmSync(lock);
    status = "took-over-stale";
  }
  try {
    const fd = openSync(lock, "wx"); // exclusive create: loses cleanly to a racing run
    writeSync(fd, JSON.stringify({ run, startedAt: new Date().toISOString() }));
    closeSync(fd);
  } catch (error) {
    if (error.code === "EEXIST") return { status: "busy" };
    throw error;
  }
  return { status, run };
}

export function releaseLock(dir, run) {
  const lock = path.join(dir, "run.lock");
  if (existsSync(lock) && readJson(lock).run === run) unlinkSync(lock);
  return { status: "released" };
}

// ------------------------------------------------------------------------------------------------ ledger

export function appendLedger(dir, entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("ledger entry must be an object");
  if (typeof entry.event !== "string" || typeof entry.run !== "string") throw new Error("ledger entry needs string fields `event` and `run`");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  appendFileSync(path.join(dir, "ledger.jsonl"), `${JSON.stringify({ ts, ...entry })}\n`);
  return ts;
}

/** Last-known state per document, derived only from the append-only ledger. */
export function replayLedger(file) {
  const docs = {};
  let lines = 0;
  let skipped = 0;
  for (const line of existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []) {
    lines += 1;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      skipped += 1; // a torn last line must not block recovery
      continue;
    }
    if (!e.doc) continue;
    const d = (docs[e.doc] ??= { status: "interrupted", attempts: 0 });
    if (e.event === "doc_start") Object.assign(d, { status: "interrupted", attempts: d.attempts + 1 });
    else if (e.event === "doc_done") Object.assign(d, { status: e.status ?? "done", sourceSha256: e.sourceSha256, translationSha256: e.translationSha256, runId: e.run, doneAt: e.ts, flags: e.flags ?? [] });
    else if (e.event === "doc_adopted") Object.assign(d, { status: "done", sourceSha256: e.sourceSha256, translationSha256: e.translationSha256, runId: e.run, doneAt: e.ts, adopted: true });
    else if (e.event === "doc_rehashed") Object.assign(d, { translationSha256: e.translationSha256 });
    else if (e.event === "doc_requeued") Object.assign(d, { sourceSha256: e.sourceSha256 });
    else if (e.event === "doc_failed") Object.assign(d, { status: e.status ?? "failed", runId: e.run });
  }
  return { docs, ledgerLines: lines, skippedLines: skipped };
}

// ------------------------------------------------------------------------------------------------ snapshot

/** [label, path] in recovery order: snapshot.json, then backups newest first. */
export function snapshotCandidates(dir) {
  const out = [["snapshot", path.join(dir, "snapshot.json")]];
  const backup = path.join(dir, "backup");
  if (existsSync(backup)) for (const n of readdirSync(backup).filter((x) => x.endsWith(".json")).sort().reverse()) out.push([`backup:${n}`, path.join(backup, n)]);
  return out;
}

const PROGRESS_EVENTS = new Set(["doc_done", "doc_failed", "doc_adopted"]);

/** Does the ledger record finished work? `doc_start` alone (a run that has only begun) is not evidence of a lost snapshot. */
function ledgerHasProgress(file) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      if (PROGRESS_EVENTS.has(JSON.parse(line).event)) return true;
    } catch {
      /* torn line */
    }
  }
  return false;
}

/** snapshot → newest valid backup → ledger replay (only if the ledger shows finished work) → empty. Never throws. */
export function loadSnapshotChain(dir, locale = null) {
  for (const [source, p] of snapshotCandidates(dir)) {
    if (existsSync(p) && validJson(p)) return { snapshot: { ...emptySnapshot(locale), ...readJson(p) }, source };
  }
  const ledger = path.join(dir, "ledger.jsonl");
  if (ledgerHasProgress(ledger)) return { snapshot: { ...emptySnapshot(locale), docs: replayLedger(ledger).docs }, source: "ledger" };
  return { snapshot: emptySnapshot(locale), source: "none" };
}

/** Last document-level ledger event per document: Map<doc, {event, run, starts}>; `starts` counts consecutive unfinished doc_start lines. */
export function ledgerTail(dir) {
  const tail = new Map();
  const file = path.join(dir, "ledger.jsonl");
  if (!existsSync(file)) return tail;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.doc && (e.event === "doc_start" || PROGRESS_EVENTS.has(e.event))) {
        const prev = tail.get(e.doc);
        tail.set(e.doc, { event: e.event, run: e.run, starts: e.event === "doc_start" ? (prev?.event === "doc_start" ? prev.starts : 0) + 1 : 0 });
      }
    } catch {
      /* torn line */
    }
  }
  return tail;
}

/** Is a run active right now? Same age-only rule as acquireLock. */
export function lockHeld(dir, maxMinutes = 270) {
  const lock = path.join(dir, "run.lock");
  if (!existsSync(lock)) return false;
  try {
    const age = Date.now() - Date.parse(readJson(lock).startedAt ?? 0);
    return Number.isFinite(age) && age < maxMinutes * 60_000;
  } catch {
    return false;
  }
}

export function writeSnapshot(dir, run, text, keep = 14) {
  mkdirSync(dir, { recursive: true });
  const current = path.join(dir, "snapshot.json");
  if (existsSync(current) && validJson(current)) {
    const backup = path.join(dir, "backup");
    mkdirSync(backup, { recursive: true });
    copyFileSync(current, path.join(backup, `snapshot.${run}.${Date.now()}.json`));
    const old = readdirSync(backup).filter((n) => n.endsWith(".json")).sort();
    for (const name of old.slice(0, Math.max(0, old.length - keep))) rmSync(path.join(backup, name));
  }
  const tmp = `${current}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, current); // atomic on the same filesystem
}

const baseCopyPath = (dir, doc) => path.join(dir, "base", doc);
export const baseSourcePath = baseCopyPath;

function saveBase(dir, doc, sourceFile) {
  const dest = baseCopyPath(dir, doc);
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  copyFileSync(sourceFile, tmp);
  renameSync(tmp, dest);
}

/**
 * One finished document: hash both files, append `doc_done`, update the snapshot atomically, and keep a copy of the source
 * it was translated from (state/base/<doc>) so a later change can be applied incrementally.
 */
export function finalizeDoc(o) {
  const { dir, run, doc } = o;
  const sourceSha256 = sha256File(path.resolve(o.sourceFile));
  const translationSha256 = sha256File(path.resolve(o.translationFile));
  if (sourceSha256 === translationSha256) throw new Error("source and translation hash are identical; refusing to record");
  const status = o.status ?? "done";
  if (!["done", "done_flagged"].includes(status)) throw new Error("status must be done or done_flagged");
  const flags = o.flags ?? [];
  if (!Array.isArray(flags)) throw new Error("flags must be an array");
  if (status === "done" && flags.length) throw new Error("flags present: use status done_flagged");
  const snapshot = loadSnapshotChain(dir, o.locale).snapshot;
  const prior = snapshot.docs[doc] ?? {};
  const now = new Date().toISOString();
  const rel = path.relative(path.resolve(o.repo ?? process.cwd()), path.resolve(o.translationFile)).split(path.sep).join("/");
  const entry = {
    ...prior,
    status, sourceSha256,
    sourceRevision: o.sourceRevision ?? snapshot.sourceRevision ?? null,
    translationPath: rel, translationSha256,
    glossaryVersion: o.glossaryVersion ?? snapshot.glossaryVersion ?? null,
    attempts: o.attempts ?? ((prior.attempts ?? 0) || 1),
    runId: run, doneAt: now, reviewedAt: prior.reviewedAt ?? null, flags, note: prior.note ?? "",
  };
  delete entry.adopted;
  for (const k of ["model", "retries", "seconds", "tokens", "termTargets"]) {
    if (o[k] !== undefined) entry[k] = o[k];
    else delete entry[k];
  }
  snapshot.docs[doc] = entry;
  snapshot.updatedAt = now;
  snapshot.lastRun = run;
  if (o.sourceRevision) snapshot.sourceRevision = o.sourceRevision;
  if (o.glossaryVersion !== undefined && o.glossaryVersion !== null) snapshot.glossaryVersion = o.glossaryVersion;
  if (o.glossarySha256) snapshot.glossarySha256 = o.glossarySha256;
  if (o.keepBase !== false) saveBase(dir, doc, path.resolve(o.sourceFile));
  writeSnapshot(dir, run, `${JSON.stringify(snapshot, null, 2)}\n`);
  const ledger = { event: "doc_done", run, doc, status, sourceSha256, translationSha256, flags };
  for (const k of ["model", "retries", "seconds", "tokens"]) if (o[k] !== undefined) ledger[k] = o[k];
  appendLedger(dir, ledger);
  return { status: "finalized", doc, sourceSha256, translationSha256 };
}

/**
 * Record existing translations as the baseline: "this translation is current for this source". One snapshot write for the batch,
 * one `doc_adopted` ledger line per document. Documents already recorded are left alone.
 */
export function adoptDocs({ dir, run, locale, entries, sourceRevision, glossaryVersion, glossarySha256, note }) {
  const snapshot = loadSnapshotChain(dir, locale).snapshot;
  const now = new Date().toISOString();
  const adopted = [];
  for (const e of entries) {
    if (snapshot.docs[e.doc]) continue;
    snapshot.docs[e.doc] = {
      status: "done", adopted: true, sourceSha256: e.sourceSha256, sourceRevision: sourceRevision ?? null,
      translationPath: e.translationPath, translationSha256: e.translationSha256, glossaryVersion: glossaryVersion ?? null,
      attempts: 0, runId: run, doneAt: now, reviewedAt: null, flags: [], note: note ?? "adopted: existing translation assumed current for this source",
    };
    adopted.push(e);
  }
  if (adopted.length) {
    snapshot.updatedAt = now;
    snapshot.lastRun = run;
    if (sourceRevision) snapshot.sourceRevision = sourceRevision;
    if (glossarySha256) snapshot.glossarySha256 = glossarySha256;
    if (glossaryVersion !== undefined && glossaryVersion !== null) snapshot.glossaryVersion = glossaryVersion;
    writeSnapshot(dir, run, `${JSON.stringify(snapshot, null, 2)}\n`);
    for (const e of adopted) appendLedger(dir, { event: "doc_adopted", run, doc: e.doc, sourceSha256: e.sourceSha256, translationSha256: e.translationSha256 });
  }
  return { adopted: adopted.map((e) => e.doc) };
}

/**
 * A translation file of an already recorded document was rewritten by a tool (not by a person): record its new hash so it
 * stays `fresh` instead of turning `edited`. One snapshot write, one `doc_rehashed` ledger line per document.
 */
export function rehashDocs({ dir, run, locale, entries }) {
  const snapshot = loadSnapshotChain(dir, locale).snapshot;
  const now = new Date().toISOString();
  const done = [];
  for (const e of entries) {
    const d = snapshot.docs[e.doc];
    if (!d) continue;
    d.translationSha256 = e.translationSha256;
    done.push(e);
  }
  if (done.length) {
    snapshot.updatedAt = now;
    snapshot.lastRun = run;
    writeSnapshot(dir, run, `${JSON.stringify(snapshot, null, 2)}\n`);
    for (const e of done) appendLedger(dir, { event: "doc_rehashed", run, doc: e.doc, translationSha256: e.translationSha256, reason: e.reason ?? "tool rewrite" });
  }
  return { rehashed: done.map((e) => e.doc) };
}

/**
 * Send finished documents back to the backlog: the recorded source hash becomes a placeholder, so each one is `stale` and the next
 * run translates it again with the old translation as reference. Nothing else in the record changes. One snapshot write, one
 * `doc_requeued` ledger line per document.
 */
export function requeueDocs({ dir, run, locale, entries, marker, reason }) {
  const snapshot = loadSnapshotChain(dir, locale).snapshot;
  const now = new Date().toISOString();
  const done = [];
  for (const e of entries) {
    const d = snapshot.docs[e.doc];
    if (!d || d.sourceSha256 === marker) continue;
    d.sourceSha256 = marker;
    d.note = `requeued: ${reason}`;
    done.push(e);
  }
  if (done.length) {
    snapshot.updatedAt = now;
    snapshot.lastRun = run;
    writeSnapshot(dir, run, `${JSON.stringify(snapshot, null, 2)}\n`);
    for (const e of done) appendLedger(dir, { event: "doc_requeued", run, doc: e.doc, sourceSha256: marker, reason });
  }
  return { requeued: done.map((e) => e.doc) };
}

/** A document that did not pass: bump attempts, record `failed` (or `blocked` at 3 attempts), keep the draft where it is. */
export function failDoc({ dir, run, doc, reason, locale, sourceSha256 }) {
  const snapshot = loadSnapshotChain(dir, locale).snapshot;
  const prior = snapshot.docs[doc] ?? {};
  const attempts = (prior.attempts ?? 0) + 1;
  const status = attempts >= 3 ? "blocked" : "failed";
  const now = new Date().toISOString();
  snapshot.docs[doc] = { ...prior, status, attempts, runId: run, note: reason ?? prior.note ?? "", ...(sourceSha256 && !prior.sourceSha256 ? { sourceSha256 } : {}) };
  snapshot.updatedAt = now;
  snapshot.lastRun = run;
  writeSnapshot(dir, run, `${JSON.stringify(snapshot, null, 2)}\n`);
  appendLedger(dir, { event: "doc_failed", run, doc, status, reason: reason ?? "" });
  return { status, attempts };
}

/**
 * Keep the snapshot's glossary version/hash in step after the glossary file was rewritten by a run (not by a human).
 * `docTerms` ({doc, termTargets}) also refreshes that document's recorded term renderings, so terms the document itself
 * introduced take part in drift detection; `promoted` ([{id, target, docs}]) registers a newly official term with the
 * documents that evidenced it.
 */
export function recordGlossary({ dir, run, locale, version, sha256: digest, docTerms, promoted = [] }) {
  const snapshot = loadSnapshotChain(dir, locale).snapshot;
  snapshot.glossaryVersion = version;
  snapshot.glossarySha256 = digest;
  if (docTerms && snapshot.docs[docTerms.doc]) snapshot.docs[docTerms.doc].termTargets = docTerms.termTargets;
  // a term that has just become official: the documents that evidenced it used that rendering, so they take part in drift detection
  for (const p of promoted) {
    for (const doc of p.docs ?? []) {
      const e = snapshot.docs[doc];
      if (e && ["done", "done_flagged"].includes(e.status)) e.termTargets = { ...(e.termTargets ?? {}), [p.id]: p.target };
    }
  }
  snapshot.updatedAt = new Date().toISOString();
  writeSnapshot(dir, run, `${JSON.stringify(snapshot, null, 2)}\n`);
}
