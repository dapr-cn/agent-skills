#!/usr/bin/env node
// tr — deterministic front end of the dapr-docs-translation skill. Node built-ins only. Full reference: references/commands.md
//
//   init     scaffold <repo>/<translations-root>/ (never overwrites)
//   scan     read-only: discover, classify every document, pick the next batch        [--locale L|all]
//   status   read-only: completeness, per-group breakdown, usage by model, CI gates   [--locale L|all]
//   adopt    record existing translations as the baseline (untracked → fresh; --as-stale: → stale, retranslated with the old text as reference)
//   fix-anchors  retarget same-document #fragment links of finished translations to the translated headings  [--only G] [--dry-run]
//   fix-punctuation  ASCII punctuation next to CJK text → full-width, outside code, links and tags  [--only G] [--dry-run]
//   triage   read-only: sort the structural-check failures into auto / retranslate / review   [--out-dir D] [--all] [--json]
//   requeue  send finished translations back to the backlog as stale   --triage retranslate[,review] | --only-from F  [--dry-run]
//   next     write one self-contained job per picked document for subagents   [--chunk-bytes N: chunk size, default 6144]
//   check    structural check of a job's draft          assemble  join chunk outputs into the draft + check
//   finalize accept a checked draft and record it       fail      record a failed attempt (blocked at 3)
//   glossary merge|audit|bootstrap   fold job candidates in / re-check existing entries / build a first glossary from an existing translation
//   glossary revert  decide terms by hand: --to source keeps the English word (do-not-translate), --to remove deletes the row   --ids a,b | --ids-from F  [--reason T] [--dry-run]
//   orphan prune     drop records of documents gone from the source whose translation file is gone too (files on disk are kept)   [--only G] [--only-from F] [--dry-run]
//
// Exit codes: 0 ok, 1 a gate / check failed, 2 usage or input error, 3 lock busy.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyse, breakdown, contentPath, globMatcher, loadProfile, oldRenderingInUse, pickLocales, plan, summarise, usageByModel } from "./lib/core.mjs";
import { alignSlots, buildBootstrap, extractSlots, matchEvidence, normalisePair, parenPairs, starterStyle } from "./lib/bootstrap.mjs";
import { DEFAULT_PROMOTE_AFTER, applyAudit, applyRevert, auditGlossary, docTitleOf, emptyGlossary, emptyPending, mergeCandidates } from "./lib/glossary.mjs";
import { buildJob, jobSlug, slugOf, termsIn, termTargetsOf } from "./lib/jobs.mjs";
import { joinChunks } from "./lib/chunk.mjs";
import { acquireLock, adoptDocs, appendLedger, failDoc, finalizeDoc, pruneOrphans, readJson, recordGlossary, rehashDocs, releaseLock, requeueDocs, sha256File } from "./lib/state.mjs";
import { fixAnchors } from "./lib/anchors.mjs";
import { fixPunctuation } from "./lib/punctuation.mjs";
import { TRIAGE_CLASSES, triage } from "./lib/triage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const trPath = path.join(here, "tr.mjs");
const BOOLEAN = new Set(["json", "verify", "dry-run", "no-exec", "if-translation-newer", "no-glossary", "apply", "merge", "static-only", "no-hints", "as-stale", "all"]);
const REPEATABLE = new Set(["locale-list", "glob", "exclude", "only", "doc"]);

const argv = process.argv.slice(2);
const command = argv.shift();
const sub = command === "glossary" || command === "orphan" ? argv.shift() : undefined;
const opt = {};
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith("--")) usage(`unexpected argument ${argv[i]}`);
  let name = argv[i].slice(2);
  if (BOOLEAN.has(name)) {
    opt[name] = true;
    continue;
  }
  if (argv[i + 1] === undefined) usage(`missing value for --${name}`);
  const value = argv[(i += 1)];
  if (command === "init" && name === "locale") name = "locale-list";
  if (REPEATABLE.has(name)) (opt[name] ??= []).push(value);
  else opt[name] = value;
}

function usage(message) {
  console.error(`tr: ${message}\nusage: tr.mjs init|scan|status|adopt|next|check|assemble|finalize|fail|glossary merge|audit|bootstrap|revert|orphan prune — see the header of ${trPath}`);
  process.exit(2);
}
function fail(message, code = 2) {
  console.error(`tr: ${message}`);
  process.exit(code);
}
const runDir = () => opt["run-dir"] ?? process.cwd();
const need = (name) => opt[name] ?? usage(`missing --${name}`);
const num = (name) => (opt[name] === undefined ? undefined : Number.isFinite(Number(opt[name])) ? Number(opt[name]) : usage(`--${name} must be a number`));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const short = (rev) => (rev ? String(rev).slice(0, 10) : "none");
const rel = (p) => path.relative(process.cwd(), p) || ".";
const isInside = (child, parent) => !path.relative(parent, child).startsWith("..") && !path.isAbsolute(path.relative(parent, child));
const defaultRun = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
const writeAtomic = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

/**
 * Run `fn` under the state lock. A run that already holds the lock (the orchestrator, which takes it for the whole run)
 * may call this with the same run id and keeps it; any other holder gets exit 3.
 */
function withLock(stateDir, runId, fn) {
  const lock = acquireLock(stateDir, runId, 30);
  if (lock.status === "busy" && lock.holder?.run !== runId) fail(`another run (${lock.holder?.run ?? "unknown"}) holds ${stateDir}/run.lock`, 3);
  try {
    return fn();
  } finally {
    if (lock.status !== "busy") releaseLock(stateDir, runId);
  }
}

// ------------------------------------------------------------------------------------------------ context

function load() {
  try {
    return loadProfile(need("profile"), { repo: opt.repo, runDir: runDir() });
  } catch (error) {
    return fail(error.message);
  }
}

function analyseLocale(ctx, locale) {
  try {
    return analyse(ctx, locale, {
      discoveryFile: opt["discovery-file"] ? path.resolve(runDir(), opt["discovery-file"]) : undefined,
      sourceRoot: opt["source-root"],
      timeoutSeconds: num("discover-timeout") ?? 300,
      noExec: Boolean(opt["no-exec"]),
    });
  } catch (error) {
    return fail(error.message);
  }
}

/** For scan/status: one analysis per selected locale (`--locale all` = every declared locale). */
function contexts() {
  const ctx = load();
  let locales;
  try {
    locales = pickLocales(ctx.profile, opt.locale);
  } catch (error) {
    return fail(error.message);
  }
  return { ctx, runs: locales.map((locale) => ({ ctx, locale, analysis: analyseLocale(ctx, locale) })) };
}

/** For commands that write: exactly one locale. */
function single() {
  if (opt.locale === "all") fail("this command works on one locale; pass --locale <code>");
  const { ctx, runs } = contexts();
  return { ctx, ...runs[0] };
}

/**
 * Glossary hygiene for scan/status: what `glossary audit` would remove or demote, and renderings shared by two terms.
 * Cheap enough to run every time (it reads the finished translations once). Null when there is no glossary or hints are off.
 */
function glossaryHints(ctx, analysis) {
  if (opt["no-hints"] || !analysis.glossary.exists || !analysis.glossary.data) return null;
  const options = glossaryOptions(ctx.profile);
  const { docs, skipped } = finishedTexts(analysis);
  const judged = docs.length > 0;
  const hasAuto = (analysis.glossary.data.terms ?? []).some((t) => t.origin === "auto" && !t.locked);
  const audit = auditGlossary(analysis.glossary.data, { docs, minDocs: judged ? options.promoteAfter : 0, ignore: options.ignore });
  const collisions = audit.notes.filter((n) => n.kind === "collision");
  const hints = {
    remove: audit.remove.length, demote: audit.demote.length, collisions: collisions.length,
    inconsistent: audit.notes.filter((n) => n.kind === "inconsistent").length, evidenceJudged: judged,
    evidenceSkipped: !judged && hasAuto && skipped.length > 0, documents: docs.length,
  };
  hints.total = hints.remove + hints.demote + hints.collisions;
  return hints;
}

function hintLine(hints) {
  // quiet when the glossary is fine; "evidence not checked" is only worth saying alongside a real finding
  if (!hints || hints.total === 0) return null;
  const parts = [];
  if (hints.remove) parts.push(`${hints.remove} ${hints.remove === 1 ? "entry was" : "entries were"} never a term`);
  if (hints.demote) parts.push(`${hints.demote} lack${hints.demote === 1 ? "s" : ""} evidence in the finished translations`);
  if (hints.collisions) parts.push(`${hints.collisions} rendering${hints.collisions === 1 ? " is" : "s are"} shared by two source terms`);
  const note = hints.evidenceSkipped ? "; evidence was not checked because the source file location is unknown (add --source-root)" : "";
  const cmd = `node ${rel(trPath)} glossary audit --profile ${opt.profile}${opt["source-root"] ? ` --source-root ${opt["source-root"]}` : ""}`;
  return `glossary  needs attention: ${parts.join(", ")}${note}\n          → ${cmd}   (review the report, then add --apply)`;
}

function header({ ctx, locale, analysis }, summary, hints) {
  const revNote = analysis.snapshot.sourceRevision && analysis.sourceRevision && analysis.snapshot.sourceRevision !== analysis.sourceRevision ? " (changed since the last recorded run)" : "";
  return [
    `repo      ${rel(ctx.repo)}   locale ${locale}`,
    `source    ${analysis.via}   revision ${short(analysis.sourceRevision)} / recorded ${short(analysis.snapshot.sourceRevision)}${revNote}`,
    `state     ${analysis.snapshotSource === "snapshot" ? "snapshot.json" : analysis.snapshotSource === "none" ? "empty (first run)" : `RECOVERED from ${analysis.snapshotSource}`}   glossary ${analysis.glossary.exists ? `v${analysis.glossary.version ?? "?"}${analysis.glossary.changedOutsideRun ? " (changed outside a run)" : ""}${analysis.glossary.pendingCount ? `, ${analysis.glossary.pendingCount} pending` : ""}` : analysis.glossary.pendingCount ? `not created yet, ${analysis.glossary.pendingCount} pending` : "not created yet"}`,
    `docs      ${Object.keys(analysis.docs).length - summary.counts.orphan} discovered, ${summary.counts.external + summary.counts.superseded} with an external translation, ${summary.translatable} translatable`,
    ...(hintLine(hints) ? [hintLine(hints)] : []),
  ].join("\n");
}
const countsLine = (counts) => Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" | ") || "nothing";

// ------------------------------------------------------------------------------------------------ scan

function scanResult(run) {
  const { analysis } = run;
  const hints = glossaryHints(run.ctx, analysis);
  const summary = summarise(analysis.docs);
  const work = plan(analysis, { maxDocs: num("max-docs"), maxBytes: num("max-bytes") });
  const attention = Object.values(analysis.docs).filter((d) => ["edited", "untracked", "orphan", "blocked", "missing"].includes(d.class) || (d.class === "stale" && d.edited));
  const result = {
    schema: 1, generatedAt: new Date().toISOString(), repo: run.ctx.repo, locale: run.locale, via: analysis.via,
    sourceRevision: analysis.sourceRevision, recordedSourceRevision: analysis.snapshot.sourceRevision ?? null, snapshotSource: analysis.snapshotSource,
    glossary: { exists: analysis.glossary.exists, version: analysis.glossary.version, changedOutsideRun: analysis.glossary.changedOutsideRun, pending: analysis.glossary.pendingCount, hints },
    summary: { ...summary.counts, translatable: summary.translatable, covered: summary.covered, adopted: summary.adopted, coverage: summary.coverage },
    limits: work.limits,
    picked: work.picked.map(({ abs, translationPath, ...d }) => ({ ...d, source: abs, translation: translationPath })),
    pending: work.pending.map((d) => ({ doc: d.doc, class: d.class, bytes: d.bytes, tier: d.tier, attempts: d.attempts, edited: d.edited, incremental: d.incremental, reason: d.reason })),
    attention: attention.map((d) => ({ doc: d.doc, class: d.class, edited: d.edited, reason: d.reason })),
  };
  return { result, summary, work, attention };
}

function printScan(run, { summary, work, attention, result }) {
  const pickedSet = new Set(work.picked.map((d) => d.doc));
  console.log(header(run, summary, result.glossary.hints));
  console.log(`classes   ${countsLine(summary.counts)}`);
  console.log(`coverage  ${summary.covered}/${summary.translatable} (${pct(summary.coverage)})${summary.adopted ? `   ${summary.adopted} adopted as baseline (not verified by a run)` : ""}`);
  console.log(`\nwork plan: ${work.picked.length} picked of ${work.pending.length} pending (${work.pickedBytes} bytes; limits docs ${work.limits.maxDocs ?? "∞"}, bytes ${work.limits.maxSourceBytes ?? "∞"})`);
  for (const d of work.pending.slice(0, 60)) console.log(`  ${pickedSet.has(d.doc) ? "*" : " "} ${d.class.padEnd(11)} t${d.tier} ${String(d.bytes).padStart(7)} B  ${d.doc}${d.incremental ? "  [incremental]" : ""}${d.edited ? "  [translation was edited by hand]" : ""}`);
  if (work.pending.length > 60) console.log(`    … ${work.pending.length - 60} more (use --json)`);
  if (attention.length) {
    console.log("\nneeds a human decision:");
    for (const d of attention.slice(0, 40)) console.log(`  ${d.class.padEnd(9)} ${d.doc}  — ${d.reason}${d.class === "stale" ? " (retranslating would overwrite the hand edits)" : ""}`);
  }
}

function scan() {
  const { ctx, runs } = contexts();
  const parts = runs.map((run) => ({ run, ...scanResult(run) }));
  const payload = parts.length === 1 && opt.locale !== "all" ? parts[0].result : { schema: 1, locales: Object.fromEntries(parts.map((p) => [p.run.locale, p.result])) };
  if (opt.out) {
    const out = path.resolve(runDir(), opt.out);
    if (isInside(out, ctx.translationsRoot)) fail(`--out ${out} is inside the translations root; write plans outside the repository (e.g. the session scratchpad)`);
    writeAtomic(out, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (opt.json) return void console.log(JSON.stringify(payload, null, 2));
  parts.forEach((p, k) => {
    if (k) console.log("\n----------------------------------------");
    printScan(p.run, p);
  });
}

// ------------------------------------------------------------------------------------------------ check helpers

function checkerArgs(job) {
  const args = ["--translatable", (job.rules?.frontmatterTranslatable ?? ["title", "description"]).join(",")];
  if (job.glossaryFile && existsSync(job.glossaryFile)) args.push("--glossary", job.glossaryFile);
  if (job.cjk) args.push("--min-cjk-ratio", "0.2", "--cjk-punctuation");
  // profile rules.checks: opt-in tolerances that follow the repository's translation convention
  if (job.rules?.checks?.fenceComments === "translate") args.push("--fence-comments", "translate");
  if (job.rules?.checks?.inlinePlaceholders === "translate") args.push("--inline-placeholders", "translate");
  if (job.rules?.checks?.localizedUrls === "allow") args.push("--localized-urls", "allow");
  return args;
}

function runChecker(sourceFile, translationFile, args, cwd) {
  const r = spawnSync("node", [path.join(here, "check-translation.mjs"), sourceFile, translationFile, ...args], { cwd, encoding: "utf8" });
  try {
    return { status: r.status, out: JSON.parse(r.stdout) };
  } catch {
    return { status: 2, out: { ok: false, hard: [{ check: "checker", message: (r.stderr || r.stdout || "no output").trim().slice(0, 300) }], soft: [] } };
  }
}

// ------------------------------------------------------------------------------------------------ status

function verifyAll(run) {
  const { ctx, locale, analysis } = run;
  const job = { rules: ctx.profile.rules, glossaryFile: analysis.glossary.exists ? analysis.glossary.file : null, cjk: ctx.profile.locales[locale]?.cjk };
  const results = { checked: 0, skipped: [], hard: [], soft: 0 };
  for (const d of Object.values(analysis.docs).filter((x) => ["fresh", "edited"].includes(x.class))) {
    if (!d.abs || !existsSync(d.abs)) {
      results.skipped.push(d.doc);
      continue;
    }
    const r = runChecker(d.abs, d.translationPath, checkerArgs(job), ctx.repo);
    results.checked += 1;
    if (!r.out.ok) results.hard.push({ doc: d.doc, failures: r.out.hard });
    results.soft += r.out.soft?.length ?? 0;
  }
  return results;
}

function statusResult(run) {
  const { analysis } = run;
  const hints = glossaryHints(run.ctx, analysis);
  const summary = summarise(analysis.docs);
  const verify = opt.verify ? verifyAll(run) : null;
  const gates = [];
  const failUnder = num("fail-under");
  if (failUnder !== undefined && summary.coverage * 100 < failUnder) gates.push(`coverage ${pct(summary.coverage)} is below ${failUnder}%`);
  for (const c of (opt["fail-on"] ?? "").split(",").filter(Boolean)) {
    if (c === "glossary") {
      if (hints?.total > 0) gates.push(`the glossary needs attention (${hints.remove} never terms, ${hints.demote} lack evidence, ${hints.collisions} shared renderings): run glossary audit`);
      continue;
    }
    if (!(c in summary.counts)) usage(`--fail-on: unknown class "${c}" (known: ${Object.keys(summary.counts).join(", ")}, glossary)`);
    if (summary.counts[c] > 0) gates.push(`${summary.counts[c]} document(s) are ${c}`);
  }
  if (verify?.hard.length) gates.push(`${verify.hard.length} finished translation(s) fail the structural checks`);
  // a verify that skipped documents proved nothing about them: never let that read as a pass
  if (verify?.skipped.length) gates.push(`${verify.skipped.length} finished translation(s) were not checked: source file location unknown (pass a --source-root relative to the repository, or use sources.glob)`);
  const result = {
    schema: 1, generatedAt: new Date().toISOString(), locale: run.locale, snapshotSource: analysis.snapshotSource,
    sourceRevision: analysis.sourceRevision, recordedSourceRevision: analysis.snapshot.sourceRevision ?? null,
    glossary: { exists: analysis.glossary.exists, version: analysis.glossary.version, changedOutsideRun: analysis.glossary.changedOutsideRun, pending: analysis.glossary.pendingCount, hints },
    summary: { ...summary.counts, translatable: summary.translatable, covered: summary.covered, coverage: summary.coverage, adopted: summary.adopted, flaggedFinished: summary.flagged },
    breakdown: breakdown(analysis.docs, num("group-depth") ?? 2),
    usage: usageByModel(analysis.snapshot),
    problems: Object.values(analysis.docs).filter((d) => !["fresh", "external", "superseded", "new"].includes(d.class)).map((d) => ({ doc: d.doc, class: d.class, edited: d.edited, attempts: d.attempts, reason: d.reason })),
    verify, gates,
  };
  return { result, summary };
}

function printStatus(run, { result, summary }) {
  console.log(header(run, summary, result.glossary.hints));
  console.log(`classes   ${countsLine(summary.counts)}`);
  console.log(`coverage  ${summary.covered}/${summary.translatable} (${pct(summary.coverage)})${summary.flagged ? `   ${summary.flagged} finished with flags` : ""}${summary.adopted ? `   ${summary.adopted} adopted as baseline` : ""}\n`);
  const rows = result.breakdown;
  const w = Math.max(5, ...rows.map((r) => r.group.length));
  console.log(`${"group".padEnd(w)}  total  done  todo  other`);
  for (const r of rows) console.log(`${r.group.padEnd(w)}  ${String(r.total).padStart(5)}  ${String(r.covered).padStart(4)}  ${String(r.pending).padStart(4)}  ${String(r.other).padStart(5)}`);
  if (result.problems.length) {
    console.log("\nnot up to date or needs attention:");
    for (const p of result.problems.slice(0, 40)) console.log(`  ${p.class.padEnd(11)} ${p.doc}${p.reason ? `  — ${p.reason}` : ""}`);
    if (result.problems.length > 40) console.log(`  … ${result.problems.length - 40} more (use --json)`);
  }
  const models = Object.entries(result.usage);
  if (models.length) {
    console.log("\nusage by model:");
    for (const [m, u] of models) console.log(`  ${m.padEnd(24)} ${u.docs} docs, ${u.retries} retries, ${u.tokensIn || u.tokensOut ? `tokens ${u.tokensIn}/${u.tokensOut}, ` : ""}${Math.round(u.seconds)} s, ${u.flagged} flagged`);
  }
  const v = result.verify;
  if (v) {
    console.log(`\nverify: ${v.checked} translation(s) checked, ${v.hard.length} with hard failures, ${v.soft} soft flags${v.skipped.length ? `, ${v.skipped.length} skipped (source file location unknown: pass --source-root)` : ""}`);
    for (const f of v.hard) console.log(`  FAIL ${f.doc}: ${f.failures.map((x) => `${x.check}: ${x.message}`).join("; ")}`);
  }
  for (const g of result.gates) console.log(`GATE FAILED: ${g}`);
}

function status() {
  const { runs } = contexts();
  const parts = runs.map((run) => ({ run, ...statusResult(run) }));
  const multi = opt.locale === "all";
  if (opt.json) console.log(JSON.stringify(multi ? { schema: 1, locales: Object.fromEntries(parts.map((p) => [p.run.locale, p.result])) } : parts[0].result, null, 2));
  else if (multi) {
    const cols = ["fresh", "edited", "new", "stale", "drift", "failed", "blocked"];
    console.log(`${"locale".padEnd(10)} ${"coverage".padStart(9)}  ${cols.map((c) => c.padStart(7)).join(" ")}  other`);
    for (const p of parts) {
      const c = p.summary.counts;
      const other = Object.entries(c).filter(([k]) => !cols.includes(k) && !["external", "superseded"].includes(k)).reduce((a, [, n]) => a + n, 0);
      console.log(`${p.run.locale.padEnd(10)} ${pct(p.summary.coverage).padStart(9)}  ${cols.map((k) => String(c[k]).padStart(7)).join(" ")}  ${other}`);
      for (const g of p.result.gates) console.log(`  GATE FAILED (${p.run.locale}): ${g}`);
    }
  } else printStatus(parts[0].run, parts[0]);
  if (parts.some((p) => p.result.gates.length)) process.exit(1);
}

// ------------------------------------------------------------------------------------------------ adopt

function gitTime(file) {
  const dir = path.dirname(file);
  const dirty = spawnSync("git", ["-C", dir, "status", "--porcelain", "--", path.basename(file)], { encoding: "utf8" });
  if (dirty.status === 0 && dirty.stdout.trim()) return Date.now() / 1000; // uncommitted edits count as "now"
  const log = spawnSync("git", ["-C", dir, "log", "-1", "--format=%ct", "--", path.basename(file)], { encoding: "utf8" });
  if (log.status === 0 && log.stdout.trim()) return Number(log.stdout.trim());
  return statSync(file).mtimeMs / 1000;
}

const STALE_ADOPTION = "unknown:adopted-as-stale";

function adopt() {
  const run = single();
  const { ctx, locale, analysis } = run;
  const listed = opt["only-from"] ? new Set(readFileSync(path.resolve(runDir(), opt["only-from"]), "utf8").split("\n").map((x) => x.trim()).filter(Boolean)) : null;
  const byGlob = opt.only ? globMatcher(opt.only) : () => true;
  const only = (doc) => byGlob(doc) && (!listed || listed.has(doc));
  const candidates = Object.values(analysis.docs).filter((d) => d.class === "untracked" && only(d.doc));
  const adopt = [];
  const skipped = [];
  for (const d of candidates) {
    if (opt["if-translation-newer"]) {
      if (!d.abs) {
        skipped.push({ doc: d.doc, reason: "source file location unknown (pass --source-root)" });
        continue;
      }
      const st = gitTime(d.abs);
      const tt = gitTime(d.translationPath);
      if (tt < st) {
        skipped.push({ doc: d.doc, reason: "source was changed after the translation (translation is older)" });
        continue;
      }
    }
    // --as-stale: keep the translation as a reference but record it against no known source, so the document is `stale` and gets retranslated
    adopt.push({ doc: d.doc, sourceSha256: opt["as-stale"] ? STALE_ADOPTION : d.sourceSha256, translationSha256: sha256File(d.translationPath), translationPath: path.relative(ctx.repo, d.translationPath).split(path.sep).join("/") });
  }
  const report = { locale, candidates: candidates.length, adopt: adopt.map((e) => e.doc), skipped, dryRun: Boolean(opt["dry-run"]) };
  if (!opt["dry-run"] && adopt.length) {
    const runId = opt.run ?? `adopt-${defaultRun()}`;
    withLock(analysis.paths.state, runId, () => adoptDocs({ dir: analysis.paths.state, run: runId, locale, entries: adopt, sourceRevision: analysis.sourceRevision, glossaryVersion: analysis.glossary.version, glossarySha256: analysis.glossary.sha256, note: opt["as-stale"] ? "adopted as stale: the translation predates the current source; kept as a reference for retranslation" : undefined }));
    report.run = runId;
  }
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  console.log(`${opt["dry-run"] ? "would adopt" : "adopted"} ${adopt.length} of ${candidates.length} untracked translation(s) for ${locale}`);
  for (const e of adopt.slice(0, 50)) console.log(`  + ${e.doc}`);
  if (adopt.length > 50) console.log(`  … ${adopt.length - 50} more`);
  for (const s of skipped.slice(0, 50)) console.log(`  - ${s.doc}  (${s.reason})`);
  if (!adopt.length && !candidates.length) console.log("nothing untracked: every translation file already has a record");
}

/**
 * fix-anchors: a translated heading gets a new slug, so `[x](#english-slug)` no longer resolves. For every translation whose
 * source has not changed (fresh, edited, untracked) and whose headings match the source one to one, retarget those links to the
 * translated heading at the same position. Only same-document `#fragment` links change. Recorded documents stay `fresh`:
 * their new hash goes into the snapshot and the ledger (`doc_rehashed`); hand-edited and untracked files are written but not rehashed.
 */
/**
 * Rewrite finished translations with a deterministic fixer. Works on documents whose source did not change (fresh, edited,
 * untracked); a `fresh` document gets its new hash recorded so it stays fresh, the others are only written.
 * fixer(sourceText | null, translationText) → { text, fixes, unresolved, skipped? }
 */
function rewriteTranslations({ label, unit, fixer, needsSource, runPrefix }) {
  const run = single();
  const { ctx, locale, analysis } = run;
  const only = opt.only ? globMatcher(opt.only) : () => true;
  const listed = opt["only-from"] ? new Set(readFileSync(path.resolve(runDir(), opt["only-from"]), "utf8").split("\n").map((x) => x.trim()).filter(Boolean)) : null;
  const report = { locale, dryRun: Boolean(opt["dry-run"]), changed: [], clean: 0, skipped: [], unresolved: [] };
  const rehash = [];
  for (const d of Object.values(analysis.docs).filter((x) => x.translationExists && only(x.doc) && (!listed || listed.has(x.doc)))) {
    if (!["fresh", "edited", "untracked"].includes(d.class)) {
      report.skipped.push({ doc: d.doc, reason: `class ${d.class}: the source changed or the document is not translated yet` });
      continue;
    }
    if (needsSource && (!d.abs || !existsSync(d.abs))) {
      report.skipped.push({ doc: d.doc, reason: "source file location unknown (pass --source-root)" });
      continue;
    }
    const before = readFileSync(d.translationPath, "utf8");
    const r = fixer(needsSource ? readFileSync(d.abs, "utf8") : null, before);
    if (r.skipped) {
      report.skipped.push({ doc: d.doc, reason: r.skipped });
      continue;
    }
    for (const u of r.unresolved) report.unresolved.push({ doc: d.doc, ...u });
    if (!r.fixes.length) {
      report.clean += 1;
      continue;
    }
    report.changed.push({ doc: d.doc, class: d.class, fixes: r.fixes });
    if (opt["dry-run"]) continue;
    writeAtomic(d.translationPath, r.text);
    if (d.class === "fresh") rehash.push({ doc: d.doc, translationSha256: sha256File(d.translationPath), reason: label });
  }
  if (rehash.length) {
    const runId = opt.run ?? `${runPrefix}-${defaultRun()}`;
    withLock(analysis.paths.state, runId, () => rehashDocs({ dir: analysis.paths.state, run: runId, locale, entries: rehash }));
    report.run = runId;
  }
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  const total = report.changed.reduce((n, c) => n + c.fixes.length, 0);
  console.log(`${opt["dry-run"] ? "would fix" : "fixed"} ${total} ${unit} in ${report.changed.length} document(s) for ${locale}; ${report.clean} need nothing`);
  for (const c of report.changed.slice(0, 50)) console.log(`  ~ ${c.doc}  (${c.fixes.length}${c.class === "fresh" ? "" : `, ${c.class}: state hash not updated`})`);
  if (report.changed.length > 50) console.log(`  … ${report.changed.length - 50} more`);
  for (const s of report.skipped.slice(0, 30)) console.log(`  - ${s.doc}  (${s.reason})`);
  if (report.skipped.length > 30) console.log(`  … ${report.skipped.length - 30} more skipped`);
  return report;
}

function fixAnchorsCmd() {
  const report = rewriteTranslations({ label: "fix-anchors", unit: "anchor link(s)", fixer: fixAnchors, needsSource: true, runPrefix: "fix-anchors" });
  if (report?.unresolved.length) console.log(`${report.unresolved.length} link(s) name no heading of the source either; left unchanged (first: ${report.unresolved[0].doc}:${report.unresolved[0].line} #${report.unresolved[0].fragment})`);
}

function fixPunctuationCmd() {
  const report = rewriteTranslations({ label: "fix-punctuation", unit: "punctuation mark(s)", fixer: (_src, text) => fixPunctuation(text), needsSource: false, runPrefix: "fix-punct" });
  if (report?.unresolved.length) console.log(`${report.unresolved.length} mark(s) could not be converted without guessing; left unchanged (first: ${report.unresolved[0].doc}:${report.unresolved[0].line} "${report.unresolved[0].context}")`);
}

// ------------------------------------------------------------------------------------------------ triage / requeue

function triageResult(run) {
  const verify = verifyAll(run);
  const docs = triage(verify.hard);
  const by = Object.fromEntries(TRIAGE_CLASSES.map((c) => [c, docs.filter((d) => d.class === c)]));
  return { verify, docs, by };
}

function triageCmd() {
  const run = single();
  const { verify, docs, by } = triageResult(run);
  if (verify.skipped.length) fail(`${verify.skipped.length} finished translation(s) could not be checked (source file location unknown): pass --source-root`);
  if (opt["out-dir"]) {
    const dir = path.resolve(runDir(), opt["out-dir"]);
    if (isInside(dir, run.ctx.translationsRoot)) fail(`--out-dir ${dir} is inside the translations root; use the session scratchpad`);
    mkdirSync(dir, { recursive: true });
    for (const c of TRIAGE_CLASSES) writeAtomic(path.join(dir, `${c}.txt`), by[c].map((d) => d.doc).join("\n") + (by[c].length ? "\n" : ""));
  }
  if (opt.json) return void console.log(JSON.stringify({ locale: run.locale, checked: verify.checked, failing: docs.length, counts: Object.fromEntries(TRIAGE_CLASSES.map((c) => [c, by[c].length])), docs }, null, 2));
  console.log(`${run.locale}: ${verify.checked} translation(s) checked, ${docs.length} fail the structural checks`);
  const advice = { auto: "fix-punctuation repairs these", retranslate: "structure no longer matches the source: requeue --triage retranslate", review: "same shape, different content: read before deciding" };
  for (const c of TRIAGE_CLASSES) {
    console.log(`\n${c}: ${by[c].length}  (${advice[c]})`);
    for (const d of by[c].slice(0, opt.all ? Infinity : 15)) console.log(`  ${d.doc}  — ${d.reasons.map((r) => r.why).join("; ")}`);
    if (!opt.all && by[c].length > 15) console.log(`  … ${by[c].length - 15} more (--all, --json, or --out-dir)`);
  }
  if (opt["out-dir"]) console.log(`\nlists written to ${path.resolve(runDir(), opt["out-dir"])}/{${TRIAGE_CLASSES.join(",")}}.txt`);
}

const REQUEUED = "unknown:requeued";

function requeueCmd() {
  const run = single();
  const { ctx, locale, analysis } = run;
  let names;
  if (opt["only-from"]) names = new Set(readFileSync(path.resolve(runDir(), opt["only-from"]), "utf8").split("\n").map((x) => x.trim()).filter(Boolean));
  else if (opt.triage) {
    const wanted = String(opt.triage).split(",");
    for (const c of wanted) if (!TRIAGE_CLASSES.includes(c) || c === "auto") fail(`--triage: "${c}" is not one of retranslate, review`);
    const { verify, docs } = triageResult(run);
    if (verify.skipped.length) fail(`${verify.skipped.length} finished translation(s) could not be checked (source file location unknown): pass --source-root`);
    names = new Set(docs.filter((d) => wanted.includes(d.class)).map((d) => d.doc));
  } else fail("requeue needs --triage <retranslate[,review]> or --only-from <file>");
  const reason = String(opt.reason ?? (opt.triage ? `structural check failures (${opt.triage})` : "listed for retranslation"));
  const entries = [];
  const skipped = [];
  for (const name of names) {
    const d = analysis.docs[name];
    if (!d) skipped.push({ doc: name, reason: "not a discovered document" });
    else if (!["fresh", "edited"].includes(d.class)) skipped.push({ doc: name, reason: `class ${d.class}: only finished translations are requeued` });
    else entries.push({ doc: name });
  }
  const report = { locale, dryRun: Boolean(opt["dry-run"]), requeue: entries.map((e) => e.doc), skipped, reason };
  if (!opt["dry-run"] && entries.length) {
    const runId = opt.run ?? `requeue-${defaultRun()}`;
    withLock(analysis.paths.state, runId, () => requeueDocs({ dir: analysis.paths.state, run: runId, locale, entries, marker: REQUEUED, reason }));
    report.run = runId;
  }
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  console.log(`${opt["dry-run"] ? "would requeue" : "requeued"} ${entries.length} document(s) for ${locale} (they become stale and are translated again with the old translation as reference)`);
  for (const e of entries.slice(0, 50)) console.log(`  ~ ${e.doc}`);
  if (entries.length > 50) console.log(`  … ${entries.length - 50} more`);
  for (const s of skipped.slice(0, 30)) console.log(`  - ${s.doc}  (${s.reason})`);
}

// ------------------------------------------------------------------------------------------------ next / jobs

function next() {
  const run = single();
  const { ctx, locale, analysis } = run;
  const outDir = path.resolve(runDir(), need("out-dir"));
  if (isInside(outDir, ctx.translationsRoot)) fail(`--out-dir ${outDir} is inside the translations root; use the session scratchpad`);
  let picked;
  if (opt.doc) {
    picked = opt.doc.map((name) => analysis.docs[name] ?? fail(`--doc ${name}: not a discovered document`));
    for (const d of picked) if (d.external || d.class === "orphan") fail(`--doc ${d.doc}: ${d.class} documents are not translated here`);
  } else picked = plan(analysis, { maxDocs: num("max-docs"), maxBytes: num("max-bytes") }).picked;
  const glossary = analysis.glossary.data;
  const stylePath = path.join(analysis.paths.glossary, "style.md");
  const styleText = existsSync(stylePath) ? readFileSync(stylePath, "utf8") : "";
  const runId = opt.run ?? null;
  const jobs = [];
  for (const d of picked) {
    const jobDir = path.join(outDir, jobSlug(d.doc));
    let built;
    try {
      built = buildJob({ ctx, locale, analysis, d, jobDir, runId, trPath, glossary, styleText, chunkBytes: num("chunk-bytes") });
    } catch (error) {
      fail(error.message);
    }
    if (runId) appendLedger(analysis.paths.state, { event: "doc_start", run: runId, doc: d.doc, sourceSha256: d.sourceSha256 });
    jobs.push({ doc: d.doc, class: d.class, mode: built.job.mode, bytes: d.bytes, chunks: built.job.chunks?.length ?? 0, job: built.file });
  }
  const manifest = { schema: 1, generatedAt: new Date().toISOString(), locale, run: runId, models: ctx.profile.models ?? {}, jobs };
  writeAtomic(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (opt.json) return void console.log(JSON.stringify(manifest, null, 2));
  console.log(`${jobs.length} job(s) written under ${outDir}${runId ? ` (doc_start recorded for run ${runId})` : " (no --run: no doc_start recorded)"}`);
  for (const j of jobs) console.log(`  ${j.class.padEnd(11)} ${j.mode.padEnd(26)} ${String(j.bytes).padStart(7)} B${j.chunks ? `  ${j.chunks} chunks` : ""}  ${j.doc}`);
}

const readJob = () => {
  const file = path.resolve(runDir(), need("job"));
  try {
    return { file, job: readJson(file) };
  } catch (error) {
    return fail(`cannot read job ${file}: ${error.message}`);
  }
};

function checkJob(job, file) {
  const r = runChecker(job.source.path, file, checkerArgs(job), job.repo);
  return { file, ...r };
}

function check() {
  const { job } = readJob();
  const file = opt.file ?? job.output.draft;
  if (!existsSync(file)) fail(`draft not found: ${file}`);
  const r = checkJob(job, file);
  console.log(JSON.stringify({ file, ...r.out }, null, 2));
  process.exit(r.status === 0 ? 0 : 1);
}

function assemble() {
  const { job } = readJob();
  if (!job.chunks) fail("this job has no chunks; write output.draft directly");
  const parts = [];
  const missing = [];
  for (const c of job.chunks) {
    if (existsSync(c.out) && readFileSync(c.out, "utf8").trim()) parts.push(readFileSync(c.out, "utf8"));
    else missing.push(path.basename(c.out));
  }
  if (missing.length) fail(`missing or empty chunk output(s): ${missing.join(", ")}`, 1);
  writeAtomic(job.output.draft, joinChunks(parts));
  const r = checkJob(job, job.output.draft);
  console.log(JSON.stringify({ assembled: job.output.draft, chunks: job.chunks.length, ...r.out }, null, 2));
  process.exit(r.status === 0 ? 0 : 1);
}

const glossaryOptions = (profile) => ({ promoteAfter: Number(profile.glossary?.promoteAfter ?? DEFAULT_PROMOTE_AFTER), ignore: profile.glossary?.ignore ?? [] });
const readPending = (glossaryDir) => {
  try {
    return readJson(path.join(glossaryDir, "pending.json"));
  } catch {
    return emptyPending();
  }
};

/** Counts and details of one merge, for the command output and the ledger note. */
function mergeSummary(merged) {
  const n = (...ops) => merged.changes.filter((c) => ops.includes(c.op)).length;
  return {
    version: merged.glossary.version, added: n("add", "promote"), promoted: n("promote"), reused: n("bump"), conflicts: n("conflict"),
    staged: n("stage"), confirmed: n("confirm"), pending: merged.pending.entries.length,
    rejected: merged.rejected.map((r) => `${r.source}${r.target ? ` → ${r.target}` : ""}: ${r.reason}`),
    collisions: merged.changes.filter((c) => c.op === "collision").map((c) => `${c.id} → ${c.target} (already ${c.with})`),
  };
}
const mergeNote = (merged) => {
  const m = mergeSummary(merged);
  return `${m.added} added (${m.promoted} promoted), ${m.reused} reused, ${m.conflicts} conflicts, ${m.staged} staged, ${m.confirmed} confirmed, ${m.rejected.length} rejected, ${m.collisions.length} collisions`;
};

/**
 * Write a merge: glossary.json (only if it changed), pending.json (only if it changed), changes.jsonl, the ledger event and
 * the snapshot's glossary version/hash. Caller holds the lock.
 */
function persistGlossary({ glossaryDir, stateDir, locale, runId, merged, pendingBefore, note, docTerms }) {
  const now = new Date().toISOString();
  const file = path.join(glossaryDir, "glossary.json");
  const glossaryChanged = merged.versionBumps > 0;
  if (glossaryChanged) {
    merged.glossary.updatedAt = now;
    writeAtomic(file, `${JSON.stringify(merged.glossary, null, 2)}\n`);
  }
  if (JSON.stringify(merged.pending) !== JSON.stringify(pendingBefore ?? emptyPending())) writeAtomic(path.join(glossaryDir, "pending.json"), `${JSON.stringify(merged.pending, null, 2)}\n`);
  const log = merged.changes.map((c) => JSON.stringify({ ts: now, run: runId, ...c })).join("\n");
  if (log) {
    const logFile = path.join(glossaryDir, "changes.jsonl");
    writeFileSync(logFile, `${existsSync(logFile) ? readFileSync(logFile, "utf8") : ""}${log}\n`);
  }
  appendLedger(stateDir, { event: "glossary_change", run: runId, op: "merge", version: merged.glossary.version, note });
  const promoted = merged.changes.filter((c) => c.op === "promote" && c.target && c.docNames).map((c) => ({ id: c.id, target: c.target, docs: c.docNames }));
  if (glossaryChanged) recordGlossary({ dir: stateDir, run: runId, locale, version: merged.glossary.version, sha256: sha256File(file), docTerms, promoted });
  return now;
}

function finalize() {
  const { job } = readJob();
  const ctx = (() => {
    try {
      return loadProfile(job.profile, { repo: job.repo });
    } catch (error) {
      return fail(error.message);
    }
  })();
  if (sha256File(job.source.path) !== job.source.sha256) fail(`${job.doc}: the source changed since this job was written; run scan/next again`);
  const draft = opt.file ?? job.output.draft;
  if (!existsSync(draft)) fail(`draft not found: ${draft}`);
  const r = checkJob(job, draft);
  if (r.status !== 0) {
    console.error(JSON.stringify(r.out, null, 2));
    fail(`${job.doc}: the draft does not pass the hard checks; fix it or record the failure with \`tr.mjs fail\``, 1);
  }
  let result = {};
  if (existsSync(job.output.result)) {
    try {
      result = readJson(job.output.result);
    } catch {
      fail(`unreadable result file ${job.output.result}`);
    }
  }
  // anchor-check-skipped (older checkers only) says the environment lacked a slugger, not that the document is doubtful: warn, do not flag
  const ENVIRONMENT = new Set(["anchor-check-skipped"]);
  const softFlags = (r.out.soft ?? []).filter((s) => !ENVIRONMENT.has(s.check)).map((s) => `${s.check}: ${String(s.message).slice(0, 120)}`);
  const warnings = (r.out.soft ?? []).filter((s) => ENVIRONMENT.has(s.check)).map((s) => `${s.check}: ${s.message}`);
  let extra = [];
  if (opt.flags) {
    try {
      extra = JSON.parse(opt.flags);
    } catch {
      usage("--flags must be a JSON array");
    }
  }
  // a subagent may echo the environment notice into its own flags; it is not a statement about the document
  const ownFlags = (result.flags ?? []).filter((f) => ![...ENVIRONMENT].some((e) => String(f).startsWith(e)));
  const flags = [...ownFlags, ...extra, ...softFlags];
  const runId = opt.run ?? job.run ?? defaultRun();
  const glossaryDir = path.join(path.dirname(job.state), "glossary");
  const glossaryPath = path.join(glossaryDir, "glossary.json");

  // Term candidates join the glossary as part of accepting the document, so growth never depends on a later call.
  const glossaryReport = { merged: false };
  const candidates = (result.termCandidates ?? []).map((c) => ({ ...c, doc: job.doc }));
  let merged = null;
  let pendingBefore = null;
  let glossaryLock = null;
  // pending terms are confirmed by use, so a document with no candidates of its own still takes part
  const hasPending = glossaryOptions(ctx.profile).promoteAfter > 1 && readPending(glossaryDir).entries.length > 0;
  const wantMerge = !opt["no-glossary"] && ctx.profile.autoGlossary !== false && result.ok !== false && !result.mergedAt && (candidates.length > 0 || hasPending);
  if (!wantMerge) glossaryReport.reason = opt["no-glossary"] || ctx.profile.autoGlossary === false ? "disabled" : result.mergedAt ? "already merged" : "no term candidates";
  else {
    glossaryLock = acquireLock(job.state, runId, 30);
    if (glossaryLock.status === "busy" && glossaryLock.holder?.run !== runId) {
      glossaryReport.reason = `run ${glossaryLock.holder?.run ?? "?"} holds the lock; the candidates stay in result.json for \`tr.mjs glossary merge --job-dir\``;
      glossaryLock = null;
    } else {
      let current = emptyGlossary();
      if (existsSync(glossaryPath)) {
        try {
          current = readJson(glossaryPath);
        } catch {
          if (glossaryLock.status !== "busy") releaseLock(job.state, runId);
          fail(`unreadable glossary ${glossaryPath}`);
        }
      }
      pendingBefore = readPending(glossaryDir);
      const sourceText = readFileSync(job.source.path, "utf8");
      const translationText = readFileSync(draft, "utf8");
      merged = mergeCandidates(current, candidates, { run: runId, pending: pendingBefore, ...glossaryOptions(ctx.profile), docs: [job.doc], contextOf: () => ({ source: sourceText, translation: translationText, title: docTitleOf(sourceText) }) });
      for (const c of merged.changes.filter((x) => x.op === "collision")) flags.push(`term-collision: candidate "${c.id} → ${c.target}" was not added to the glossary; ${c.target} already stands for "${c.with}"`);
    }
  }
  try {
    const final = job.output.final;
    mkdirSync(path.dirname(final), { recursive: true });
    copyFileSync(draft, `${final}.tmp`);
    renameSync(`${final}.tmp`, final);
    if (draft === job.output.draft) unlinkSync(draft);
    const glossaryFile = job.glossaryFile && existsSync(job.glossaryFile) ? job.glossaryFile : null;
    let glossaryVersion;
    if (glossaryFile) {
      try {
        glossaryVersion = readJson(glossaryFile).version;
      } catch {
        /* version stays unknown */
      }
    }
    const tokens = opt["tokens-in"] || opt["tokens-out"] ? { in: num("tokens-in") ?? 0, out: num("tokens-out") ?? 0 } : result.tokens;
    const out = finalizeDoc({
      dir: job.state, run: runId, doc: job.doc, sourceFile: job.source.path, translationFile: final, repo: job.repo, locale: job.locale,
      status: flags.length ? "done_flagged" : "done", flags,
      attempts: ["failed", "interrupted"].includes(job.class) ? (job.attempts ?? 0) + 1 : 1,
      glossaryVersion, glossarySha256: glossaryFile ? sha256File(glossaryFile) : undefined, sourceRevision: job.source.revision ?? undefined,
      model: opt.model ?? result.model, retries: num("retries") ?? result.retries, seconds: num("seconds") ?? result.seconds, tokens,
      termTargets: merged ? termTargetsOf(termsIn(readFileSync(job.source.path, "utf8"), merged.glossary).terms) : job.termTargets,
      // a terms-only repair judged the old renderings it was given: the English words are now the record, and the kept ordinary senses are not judged again
      reviewedTerms: job.mode === "terms-only" ? Object.fromEntries((job.driftTerms ?? []).map((t) => [t.id, t.old])) : undefined,
      keepBase: ctx.profile.keepBaseSource === false ? false : undefined,
    });
    if (merged) {
      try {
        if (merged.changes.length) {
          const now = persistGlossary({ glossaryDir, stateDir: job.state, locale: job.locale, runId, merged, pendingBefore, note: `${mergeNote(merged)} (finalize ${job.doc})`, docTerms: { doc: job.doc, termTargets: termTargetsOf(termsIn(readFileSync(job.source.path, "utf8"), merged.glossary).terms) } });
          writeFileSync(job.output.result, `${JSON.stringify({ ...result, mergedAt: now }, null, 2)}\n`);
        }
        Object.assign(glossaryReport, { merged: true, ...mergeSummary(merged) });
      } catch (error) {
        glossaryReport.error = error.message;
      }
    }
    const keptTerms = Array.isArray(result.keptTerms) ? result.keptTerms : [];
    console.log(JSON.stringify({ ...out, status: flags.length ? "done_flagged" : "done", flags, warnings, keptTerms, glossary: glossaryReport, translation: path.relative(job.repo, final) }, null, 2));
  } finally {
    if (glossaryLock && glossaryLock.status !== "busy") releaseLock(job.state, runId);
  }
}

function failCmd() {
  const { job } = readJob();
  const out = failDoc({ dir: job.state, run: opt.run ?? job.run ?? defaultRun(), doc: job.doc, reason: need("reason"), locale: job.locale, sourceSha256: job.source.sha256, terms: job.mode === "terms-only" });
  console.log(JSON.stringify({ doc: job.doc, ...out }));
}

// ------------------------------------------------------------------------------------------------ glossary merge

function glossaryCmd() {
  if (sub === "merge") return glossaryMerge();
  if (sub === "audit") return glossaryAudit();
  if (sub === "bootstrap") return glossaryBootstrap();
  if (sub === "revert") return glossaryRevert();
  return usage(`unknown glossary command "${sub ?? ""}" (expected: merge, audit, bootstrap, revert)`);
}

/** The finished translations with their source text: the evidence an audit judges by. */
function finishedTexts(analysis) {
  const docs = [];
  const skipped = [];
  for (const d of Object.values(analysis.docs)) {
    if (!["fresh", "edited", "drift"].includes(d.class)) continue;
    if (!d.abs || !existsSync(d.abs) || !d.translationExists) {
      skipped.push(d.doc);
      continue;
    }
    docs.push({ doc: d.doc, source: readFileSync(d.abs, "utf8"), translation: readFileSync(d.translationPath, "utf8") });
  }
  return { docs, skipped };
}

function glossaryAudit() {
  const { ctx, locale, analysis } = single();
  if (!analysis.glossary.exists) fail("there is no glossary to audit");
  const { docs, skipped } = finishedTexts(analysis);
  const options = glossaryOptions(ctx.profile);
  const minDocs = opt["static-only"] ? 0 : num("min-docs") ?? options.promoteAfter;
  if (!opt["static-only"] && docs.length === 0) fail("no finished translation with a known source file to judge by: pass --source-root, or use --static-only to apply only the screening rules");
  const audit = auditGlossary(analysis.glossary.data, { docs, minDocs, ignore: options.ignore });
  const line = (x) => ({ id: x.id, target: x.target ?? null, kind: x.kind, reason: x.reason, usedIn: x.using?.length });
  const report = {
    locale, documents: docs.length, documentsWithoutSource: skipped.length, terms: (analysis.glossary.data.terms ?? []).length,
    keep: audit.keep.length, remove: audit.remove.map(line), demote: audit.demote.map(line), notes: audit.notes, applied: false,
  };
  if (opt.apply && (audit.demote.length || audit.remove.length)) {
    const runId = opt.run ?? defaultRun();
    withLock(analysis.paths.state, runId, () => {
      const pendingBefore = readPending(analysis.paths.glossary);
      const res = applyAudit(analysis.glossary.data, pendingBefore, audit, { run: runId });
      persistGlossary({ glossaryDir: analysis.paths.glossary, stateDir: analysis.paths.state, locale, runId, merged: { ...res, rejected: [] }, pendingBefore, note: `audit: ${audit.remove.length} removed, ${audit.demote.length} demoted to pending, ${audit.keep.length} kept` });
    });
    report.applied = true;
    report.version = (analysis.glossary.data.version ?? 0) + 1;
  }
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  console.log(`glossary audit (${locale}): ${report.terms} terms, judged against ${docs.length} finished translation(s)${skipped.length ? ` (${skipped.length} without a known source file)` : ""}`);
  console.log(`  keep ${report.keep} | remove ${report.remove.length} (never were terms) | demote ${report.demote.length} (back to pending: not enough evidence)`);
  for (const r of report.remove) console.log(`  remove  ${r.id.padEnd(26)} ${String(r.target ?? "").padEnd(10)} ${r.reason}`);
  for (const r of report.demote) console.log(`  demote  ${r.id.padEnd(26)} ${String(r.target ?? "").padEnd(10)} ${r.reason}`);
  for (const n of report.notes) console.log(`  note    ${n.kind}: ${n.kind === "collision" ? `${n.target} ← ${n.ids.join(" / ")}` : `${n.id} → ${n.target} missing in ${n.docs.join(", ")}`}`);
  console.log(report.applied ? `applied: glossary v${report.version}, changes logged in glossary/changes.jsonl` : report.demote.length || report.remove.length ? "dry run: nothing changed (use --apply)" : "nothing to change");
}

function glossaryBootstrap() {
  const { ctx, locale, analysis } = single();
  const dirs = (ctx.profile.externalTranslations?.evidence ?? []).map((d) => path.resolve(ctx.repo, String(d).replaceAll("{locale}", locale)));
  if (!dirs.length) fail("the profile has no externalTranslations.evidence directories to learn from");
  const known = Object.values(analysis.docs).filter((d) => d.class !== "orphan" && d.abs && existsSync(d.abs));
  if (!known.length) fail("no source file location is known: use sources.glob, _meta.sourceRoot in the discovery output, or pass --source-root");
  const matches = matchEvidence(known.map((d) => d.doc), dirs);
  const chosen = known.filter((d) => matches.has(d.doc)).sort((a, b) => a.tier - b.tier || a.bytes - b.bytes || a.doc.localeCompare(b.doc)).slice(0, num("max-docs") ?? 12);
  if (!chosen.length) fail(`none of the ${known.length} documents has a translation in ${dirs.map(rel).join(", ")}`);
  const options = glossaryOptions(ctx.profile);
  const pairsByDoc = new Map();
  const documents = [];
  for (const d of chosen) {
    const src = readFileSync(d.abs, "utf8");
    const ext = readFileSync(matches.get(d.doc), "utf8");
    const aligned = alignSlots(extractSlots(src), extractSlots(ext));
    const pairs = [...aligned.pairs, ...parenPairs(ext, src)].map(normalisePair).filter(Boolean);
    pairsByDoc.set(d.doc, pairs);
    documents.push({ doc: d.doc, evidence: rel(matches.get(d.doc)), aligned: aligned.aligned, failed: aligned.failed, pairs: pairs.length });
  }
  const titles = new Set();
  for (const d of known) {
    const t = docTitleOf(readFileSync(d.abs, "utf8"));
    if (t) titles.add(t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  }
  const built = buildBootstrap(pairsByDoc, { titles, minDocs: num("min-docs") ?? 2, maxTerms: num("max-terms") ?? 150, ignore: new Set(options.ignore.map((x) => String(x).toLowerCase())), seeds: ctx.profile.rules?.doNotTranslateSeeds ?? [] });
  const report = {
    locale, evidence: dirs.map(rel), documents, terms: built.terms.map((t) => ({ id: t.id, source: t.source, target: t.target, docs: t.docs.length })),
    doNotTranslate: built.doNotTranslate.map((n) => ({ term: n.term, docs: n.docs.length })), ambiguous: built.ambiguous, rejected: built.rejected, collisions: built.collisions, applied: false,
  };
  if (opt.apply) {
    if (analysis.glossary.exists && !opt.merge) fail("glossary.json already exists; use --merge to add only the terms it does not have yet");
    const runId = opt.run ?? defaultRun();
    const note = `bootstrap: ${built.terms.length} terms and ${built.doNotTranslate.length} names from ${chosen.length} document(s)`;
    withLock(analysis.paths.state, runId, () => {
      const pendingBefore = readPending(analysis.paths.glossary);
      let merged;
      if (analysis.glossary.exists) {
        const candidates = [...built.terms.map((t) => ({ doc: t.docs[0], source: t.source, target: t.target, note: "bootstrap" })), ...built.doNotTranslate.map((n) => ({ doc: n.docs?.[0] ?? "(profile)", source: n.term, doNotTranslate: true, note: n.seed ? "profile seed" : "bootstrap" }))];
        merged = mergeCandidates(analysis.glossary.data, candidates, { run: runId, pending: pendingBefore, promoteAfter: 1, ignore: options.ignore });
      } else {
        const seen = (t, which) => ({ doc: t.docs[which === "first" ? 0 : t.docs.length - 1], run: runId });
        const g = emptyGlossary();
        g.version = 1;
        g.doNotTranslate = built.doNotTranslate.map((n) => ({ term: n.term, note: n.seed ? "profile 种子" : "上游译文原样保留", origin: "bootstrap", locked: false }));
        g.terms = built.terms.map((t) => ({ id: t.id, source: t.source, target: t.target, alt: [], note: "", origin: "bootstrap", locked: false, confidence: "medium", occurrences: t.docs.length, firstSeen: seen(t, "first"), lastSeen: seen(t, "last"), conflicts: [] }));
        g.terms.sort((a, b) => a.id.localeCompare(b.id));
        merged = { glossary: g, pending: pendingBefore, versionBumps: 1, rejected: [], changes: [...g.terms.map((t) => ({ op: "add", id: t.id, target: t.target, origin: "bootstrap", version: 1, doc: t.firstSeen.doc })), ...g.doNotTranslate.map((n) => ({ op: "add", id: n.term, kind: "doNotTranslate", origin: "bootstrap", version: 1 }))] };
      }
      persistGlossary({ glossaryDir: analysis.paths.glossary, stateDir: analysis.paths.state, locale, runId, merged, pendingBefore, note });
      const styleFile = path.join(analysis.paths.glossary, "style.md");
      if (!existsSync(styleFile)) writeAtomic(styleFile, starterStyle(locale, ctx.profile.locales[locale]));
      report.version = merged.glossary.version;
    });
    report.applied = true;
  }
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  console.log(`glossary bootstrap (${locale}): learned from ${chosen.length} document(s) translated in ${report.evidence.join(", ")}`);
  for (const d of documents) console.log(`  ${d.doc}  aligned [${d.aligned.join(", ") || "-"}]${d.failed.length ? `  FAILED to align [${d.failed.join(", ")}] (dropped, not forced)` : ""}  ${d.pairs} pairs`);
  console.log(`  ${built.terms.length} terms and ${built.doNotTranslate.length} names agreed by at least ${num("min-docs") ?? 2} documents; ${built.ambiguous.length} ambiguous, ${built.rejected.length} rejected by the screen, ${built.collisions.length} collisions`);
  for (const t of report.terms.slice(0, 60)) console.log(`  term  ${t.source.padEnd(28)} → ${t.target.padEnd(12)} (${t.docs} docs)`);
  if (report.terms.length > 60) console.log(`  … ${report.terms.length - 60} more (use --json)`);
  console.log(`  names: ${report.doNotTranslate.map((n) => n.term).join(", ") || "-"}`);
  console.log(report.applied ? `applied: glossary v${report.version}` : "dry run: nothing written (use --apply; --merge adds to an existing glossary)");
}

/** Term ids from --ids (comma-separated) and --ids-from (one per line or comma-separated; `#` starts a comment). */
function idList() {
  const ids = [];
  if (opt.ids) ids.push(...String(opt.ids).split(","));
  if (opt["ids-from"]) {
    let text;
    try {
      text = readFileSync(path.resolve(runDir(), opt["ids-from"]), "utf8");
    } catch (error) {
      fail(`cannot read --ids-from: ${error.message}`);
    }
    for (const line of text.split("\n")) ids.push(...line.replace(/#.*$/, "").split(","));
  }
  return [...new Set(ids.map((x) => slugOf(x.trim())).filter(Boolean))];
}

/**
 * Finished translations that record a reverted term, or still show its old rendering. `drift` marks the ones the next scan judges as
 * drift (the same test as core's driftOf: the old rendering is in the text and the source uses the term). Edited files are never
 * judged. Reported only; nothing is requeued or retranslated here.
 */
function revertRefs(analysis, outcomes) {
  const refs = [];
  for (const o of outcomes.filter((x) => x.status === "reverted")) {
    for (const d of Object.values(analysis.docs)) {
      if (!["fresh", "edited", "drift"].includes(d.class)) continue;
      const snap = analysis.snapshot.docs[d.doc];
      const recorded = snap?.termTargets?.[o.id];
      let text = "";
      try {
        text = readFileSync(d.translationPath, "utf8");
      } catch {
        /* a missing file cannot still contain the rendering */
      }
      const shows = text.includes(o.from);
      if (recorded === undefined && !shows) continue;
      let sourceText = null;
      if (shows && d.abs) {
        try {
          sourceText = readFileSync(d.abs, "utf8");
        } catch {
          /* no source: the document cannot be judged */
        }
      }
      const drift = d.class !== "edited" && oldRenderingInUse({ id: o.id, old: o.from, snap, text, sourceText, term: { source: o.source } });
      refs.push({ id: o.id, doc: d.doc, old: o.from, recorded: recorded ?? null, drift });
    }
  }
  return refs;
}

/**
 * glossary revert: decide terms by hand. `--to source` keeps the English word (target = source, do-not-translate entry) and leaves every
 * finished translation as it is; `--to remove` deletes the term row. Same write path as audit --apply: the glossary and its log, the ledger,
 * and the snapshot's glossary version/hash. Without --dry-run it writes; with --dry-run it only reports.
 */
function glossaryRevert() {
  const to = need("to");
  if (!["source", "remove"].includes(to)) usage(`--to must be source or remove (got "${to}")`);
  const ids = idList();
  if (!ids.length) usage("nothing to revert: pass --ids <term>[,<term>…] or --ids-from <file>");
  const { locale, analysis } = single();
  if (!analysis.glossary.exists || !analysis.glossary.data) fail("there is no glossary to revert terms in");
  const dryRun = Boolean(opt["dry-run"]);
  const runId = opt.run ?? defaultRun();
  const reason = opt.reason ?? "";
  const glossaryDir = analysis.paths.glossary;
  let res = applyRevert(analysis.glossary.data, readPending(glossaryDir), { ids, to, reason });
  let applied = false;
  if (!dryRun && res.versionBumps) {
    withLock(analysis.paths.state, runId, () => {
      // re-read under the lock: the plan above was made before it, and the glossary may have changed since
      const pendingBefore = readPending(glossaryDir);
      res = applyRevert(readJson(analysis.glossary.file), pendingBefore, { ids, to, reason });
      if (!res.versionBumps) return;
      const counts = Object.fromEntries(["reverted", "removed", "already", "not-found", "skipped"].map((k) => [k, res.outcomes.filter((o) => o.status === k).length]));
      persistGlossary({
        glossaryDir, stateDir: analysis.paths.state, locale, runId,
        merged: { glossary: res.glossary, pending: res.pending, versionBumps: res.versionBumps, changes: res.changes, rejected: [] },
        pendingBefore, note: `revert (${to}): ${counts.reverted + counts.removed} changed, ${counts.already} already, ${counts["not-found"]} not found, ${counts.skipped} skipped${reason ? `; ${reason}` : ""}`,
      });
      applied = true;
    });
  }
  const refs = to === "source" ? revertRefs(analysis, res.outcomes) : [];
  const report = {
    locale, to, reason: reason || null, run: runId, dryRun, applied,
    version: res.glossary.version, outcomes: res.outcomes, withdrawnPending: res.withdrawn,
    affected: { documents: new Set(refs.map((r) => r.doc)).size, drift: refs.filter((r) => r.drift).length, rows: refs },
  };
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  const count = (k) => res.outcomes.filter((o) => o.status === k).length;
  console.log(`glossary revert (${locale}) → ${to}: ${ids.length} requested | reverted ${count("reverted")} | removed ${count("removed")} | already ${count("already")} | not found ${count("not-found")} | skipped ${count("skipped")}`);
  for (const o of res.outcomes) {
    const line = o.status === "reverted" ? `${o.id.padEnd(26)} ${String(o.from).padEnd(12)} → ${o.target}  (kept in English${o.doNotTranslate === "added" ? ", do-not-translate added" : ""})`
      : o.status === "removed" ? `${o.id.padEnd(26)} ${String(o.from).padEnd(12)} → removed`
        : o.status === "already" ? `${o.id.padEnd(26)} already in the target state`
          : o.status === "skipped" ? `${o.id.padEnd(26)} not changed: ${o.why === "locked" ? "locked" : "human-owned"} (${o.target})`
            : `${o.id.padEnd(26)} not found in the glossary`;
    console.log(`  ${o.status.padEnd(9)} ${line}`);
  }
  for (const w of res.withdrawn) console.log(`  withdrawn pending candidate for ${w.id} (${w.target}, seen in ${w.docs} document(s))`);
  if (refs.length) {
    const docs = new Set(refs.map((r) => r.doc)).size;
    console.log(`\nfinished translations that record or still show a reverted term: ${docs} document(s), ${refs.filter((r) => r.drift).length} still use the old rendering where the source uses the term and will be judged drift by the next scan (nothing requeued or retranslated here)`);
    for (const r of refs.filter((x) => x.drift).slice(0, 30)) console.log(`  drift  ${r.doc}  (${r.id}: ${r.old})`);
  }
  if (applied) console.log(`applied: glossary v${res.glossary.version}, changes logged in glossary/changes.jsonl`);
  else if (dryRun) console.log(res.versionBumps ? "dry run: nothing written (drop --dry-run to apply)" : "dry run: nothing to change");
  else console.log("nothing to change: every requested term is already in the target state, missing, or protected");
}

function glossaryMerge() {
  const { ctx, locale, analysis } = single();
  const candidates = [];
  const touched = [];
  const contexts = new Map(); // doc → {source, translation, title}, from each job's files when they exist
  if (opt.file) {
    let list;
    try {
      list = readJson(path.resolve(runDir(), opt.file));
    } catch (error) {
      fail(`cannot read --file: ${error.message}`);
    }
    candidates.push(...list);
  } else {
    const dir = path.resolve(runDir(), need("job-dir"));
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name, "result.json");
      if (!existsSync(file)) continue;
      let result;
      try {
        result = readJson(file);
      } catch {
        continue;
      }
      if (result.mergedAt || result.ok === false || !result.doc) continue;
      for (const c of result.termCandidates ?? []) candidates.push({ ...c, doc: result.doc });
      touched.push({ file, result });
      try {
        const job = readJson(path.join(dir, name, "job.json"));
        const sourceText = readFileSync(job.source.path, "utf8");
        const tFile = [job.output.final, job.output.draft].find((f) => existsSync(f));
        contexts.set(result.doc, { source: sourceText, translation: tFile ? readFileSync(tFile, "utf8") : undefined, title: docTitleOf(sourceText) });
      } catch {
        /* without the job files only the checks that need no text run */
      }
    }
  }
  const runId = opt.run ?? defaultRun();
  const current = analysis.glossary.data ?? emptyGlossary();
  const pendingBefore = readPending(analysis.paths.glossary);
  const merged = mergeCandidates(current, candidates, { run: runId, pending: pendingBefore, ...glossaryOptions(ctx.profile), docs: [...contexts.keys()], contextOf: (doc) => contexts.get(doc) ?? null });
  const summary = { locale, candidates: candidates.length, versionBumps: merged.versionBumps, ...mergeSummary(merged), dryRun: Boolean(opt["dry-run"]) };
  if (!opt["dry-run"] && merged.changes.length) { // rejections, collisions and staging are logged too (changes.jsonl) so nothing is lost
    withLock(analysis.paths.state, runId, () => {
      const now = persistGlossary({ glossaryDir: analysis.paths.glossary, stateDir: analysis.paths.state, locale, runId, merged, pendingBefore, note: mergeNote(merged) });
      for (const t of touched) writeFileSync(t.file, `${JSON.stringify({ ...t.result, mergedAt: now }, null, 2)}\n`);
    });
  }
  console.log(JSON.stringify(summary, null, 2));
}

// ------------------------------------------------------------------------------------------------ init

const LOCALE_NAMES = { "zh-CN": "简体中文", "zh-Hant": "繁體中文", "ja-JP": "日本語", "ko-KR": "한국어", "de-DE": "Deutsch", "fr-FR": "Français", "es-ES": "Español", "pt-BR": "Português (Brasil)", "ru-RU": "Русский" };
const isCjk = (code) => /^(zh|ja|ko)\b/i.test(code);
const yamlStr = (s) => JSON.stringify(s);

function init() {
  const repo = path.resolve(need("repo"));
  if (!existsSync(repo)) fail(`--repo does not exist: ${repo}`);
  const t = (opt["translations-root"] ?? "translations").replace(/\/+$/, "");
  if (path.isAbsolute(t) || t.split("/").includes("..")) fail("--translations-root must be a relative path inside the repository");
  const locales = opt["locale-list"] ?? ["zh-CN"];
  const include = opt.glob ?? ["**/*.md", "**/*.mdx"];
  const exclude = opt.exclude ?? [];
  const sourceRoot = opt["source-root"] ?? ".";
  const description = opt.description ?? "TODO: one sentence on what the source documents are and where they come from";
  const localeYaml = locales.map((code) => `  ${code}:\n    name: ${yamlStr(LOCALE_NAMES[code] ?? code)}\n    cjk: ${isCjk(code)}\n    notes: ""`).join("\n");
  const output = opt["output-template"]
    ? `output:\n  template: ${yamlStr(opt["output-template"])}      # {locale}, {dir} (locales.<L>.dir or the code), {doc}; relative to the repo\n`
    : "# output:                                 # where accepted translations go; default <translationsRoot>/locales/<L>/content/<doc>\n#   template: \"src/content/docs/{locale}/{doc}\"\n";
  const writeScope = opt["output-template"] ? `[${t}/, ${yamlStr(opt["output-template"].split("{")[0])}]` : `[${t}/]`;
  const profile = `# profile.yaml — written by \`tr.mjs init\`; human-owned from now on (runs never edit it). Field meanings: references/profile-spec.md
schema: 1
repo: ${yamlStr(path.relative(process.cwd(), repo) || ".")}   # informational; scripts locate the repo from this file's own path
translationsRoot: ${t}
defaultLocale: ${locales[0]}
locales:
${localeYaml}

sources:
  description: ${yamlStr(description)}
  glob:                                    # built-in discovery; replace with \`discovery: {cwd, command}\` for upstream/vendored sources
    root: ${yamlStr(sourceRoot)}
    include: [${include.map(yamlStr).join(", ")}]
    exclude: [${exclude.map(yamlStr).join(", ")}]

${output}
externalTranslations:
  policy: skip
  evidence: []

writeScope: ${writeScope}
readOnly: []                               # add every path the runs must not touch (sources, generated output, site code)
forbidden:
  - git push / stash / reset / checkout / new branches / --no-verify

priority: []                               # e.g. - { tier: 1, match: ["README.md", "docs/getting-started/"] }

budgets:
  maxRunMinutes: 240
  maxDocs: 10
  maxSourceBytes: 80000
  minMinutesToStartDoc: 20

models:                                    # hints copied into every job; the orchestrator maps them to subagent models
  translate: haiku
  review: haiku
  escalate: sonnet

keepBaseSource: true                       # keep the translated source under state/base/ so later changes can be applied as a diff

commit:
  enabled: false                           # turn on once the profile and adapter are committed
  messagePrefix: "docs(translation)"
  trailer: ""

timezone: UTC

rules:
  doNotTranslateSeeds: []                  # product / brand names that must stay as they are
  links: Keep relative links unchanged.
  frontmatterTranslatable: [title, description]
  extra: []
`;
  const readme = readFileSync(path.join(here, "..", "templates", "translations-README.md"), "utf8");
  const planned = [{ rel: `${t}/profile.yaml`, text: profile }, { rel: `${t}/README.md`, text: readme }];
  for (const code of locales) for (const subdir of ["drafts", "state", "glossary", "runs", ...(opt["output-template"] ? [] : ["content"])]) planned.push({ rel: `${t}/locales/${code}/${subdir}/.gitkeep`, text: "" });
  const report = [];
  for (const f of planned) {
    const abs = path.join(repo, f.rel);
    if (existsSync(abs)) {
      report.push({ path: f.rel, action: "exists (left untouched)" });
      continue;
    }
    if (!opt["dry-run"]) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.text);
    }
    report.push({ path: f.rel, action: opt["dry-run"] ? "would create" : "created" });
  }
  for (const r of report) console.log(`${r.action.padEnd(24)} ${r.path}`);
  if (!opt["dry-run"]) console.log(`\nnext: edit ${t}/profile.yaml (description, readOnly, priority, notes), commit it, then run\n  node ${trPath} scan --profile ${path.join(path.relative(process.cwd(), repo) || ".", t, "profile.yaml")}`);
}

// ------------------------------------------------------------------------------------------------ orphan

function orphanCmd() {
  if (sub === "prune") return orphanPrune();
  return usage(`unknown orphan command "${sub ?? ""}" (expected: prune)`);
}

/**
 * orphan prune: remove records of documents the source no longer has, but only when their translation file is gone as well.
 * An orphan whose translation file still exists is never touched; it is listed as kept. Without --dry-run it writes (snapshot with
 * backup rotation, one ledger line per document); with --dry-run it only reports.
 */
function orphanPrune() {
  const { ctx, locale, analysis } = single();
  const listed = opt["only-from"] ? new Set(readFileSync(path.resolve(runDir(), opt["only-from"]), "utf8").split("\n").map((x) => x.trim()).filter(Boolean)) : null;
  const byGlob = opt.only ? globMatcher(opt.only) : () => true;
  const only = (doc) => byGlob(doc) && (!listed || listed.has(doc));
  const orphans = Object.values(analysis.docs).filter((d) => d.class === "orphan" && only(d.doc));
  const prune = [];
  const kept = [];
  for (const d of orphans) {
    const translation = contentPath(ctx, locale, d.doc);
    if (existsSync(translation)) kept.push({ doc: d.doc, translation: path.relative(ctx.repo, translation).split(path.sep).join("/") });
    else prune.push({ doc: d.doc, status: d.status, reason: "source no longer discovered; translation file already gone" });
  }
  const dryRun = Boolean(opt["dry-run"]);
  const runId = opt.run ?? `prune-${defaultRun()}`;
  let applied = false;
  if (!dryRun && prune.length) {
    withLock(analysis.paths.state, runId, () => pruneOrphans({ dir: analysis.paths.state, run: runId, locale, entries: prune }));
    applied = true;
  }
  const report = { locale, run: runId, dryRun, applied, orphans: orphans.length, prune: prune.map((p) => p.doc), kept };
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  console.log(`orphan prune (${locale}): ${orphans.length} orphan record(s) → ${prune.length} to prune (source and translation file both gone), ${kept.length} kept (translation file still on disk)`);
  for (const p of prune.slice(0, 60)) console.log(`  ${dryRun ? "would prune" : applied ? "pruned" : "prune"}  ${p.doc}`);
  if (prune.length > 60) console.log(`  … ${prune.length - 60} more (use --json)`);
  for (const k of kept) console.log(`  kept    ${k.doc}  (${k.translation} still exists)`);
  if (applied) console.log(`applied: ${prune.length} record(s) removed from snapshot.json; translation files untouched`);
  else if (dryRun) console.log(prune.length ? "dry run: nothing written (drop --dry-run to apply)" : "dry run: nothing to prune");
  else console.log(prune.length ? "nothing written" : "nothing to prune");
}

const commands = { init, scan, status, adopt, "fix-anchors": fixAnchorsCmd, "fix-punctuation": fixPunctuationCmd, triage: triageCmd, requeue: requeueCmd, next, check, assemble, finalize, fail: failCmd, glossary: glossaryCmd, orphan: orphanCmd };
if (!command) usage("missing command");
else if (!commands[command]) usage(`unknown command "${command}"`);
else commands[command]();
