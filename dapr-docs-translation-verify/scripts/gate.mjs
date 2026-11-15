#!/usr/bin/env node
// dapr-docs-translation-verify — a read-only gate that answers "may this translation be offered upstream?".
// It runs three checks, looks at what the zh repository would commit, and writes a verdict that the upstream-PR skill checks.
// It never changes the working tree, the index or any ref: it takes a git status snapshot before and after the checks, and a
// check that wrote anything makes the verdict `blocked`.
//
//   gate.mjs plan [--version vX.Y] [--zh-repo DIR] [--source-repo DIR] [--mono-root DIR] [--engine DIR] [--json]
//   gate.mjs run  [same options] [--out verdict.json] [--json]
//
// Exit codes: 0 canOpenPr true; 1 the gate did not pass (fail or blocked); 2 usage or configuration error.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError, normRel, parseFlags, readProfile, resolveContext, resolveEngine, sourceRootOf, writeScopeOf } from "./lib/config.mjs";
import { classify, headCommit, spawnExec, statusDigest, statusEntries, touchedPaths } from "./lib/git.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, "..");

export const FAIL_ON = "stale,failed,blocked,orphan,drift,glossary";

/**
 * The verdict rule, as a pure function. `checks` are the three command results (exit null = did not start or time out).
 * `scope` is the classify() result of the zh repository after the checks. `snapshotChanged` is true when the status
 * before and after the checks differ; `newPaths` lists what changed.
 *   fail    : a check did not run or exited non-zero, or a path is outside writeScope
 *   blocked : a path is a sync output (needs a manual commit), or a check changed the repository
 *   pass    : everything else. canOpenPr is true only for pass.
 */
export function decide({ checks, scope, snapshotChanged = false, newPaths = [] }) {
  const reasons = [];
  let failed = false;
  let blocked = false;
  const checkResults = checks.map((c) => {
    if (c.exit === null || c.exit === undefined) {
      failed = true;
      const why = c.error ? `did not run: ${c.error}` : "did not run: no exit code";
      reasons.push(`${c.name}: ${why}`);
      return { name: c.name, verdict: "fail", exit: null, reason: why };
    }
    if (c.exit !== 0) {
      failed = true;
      reasons.push(`${c.name}: exit ${c.exit}`);
      return { name: c.name, verdict: "fail", exit: c.exit, reason: `exit ${c.exit}` };
    }
    return { name: c.name, verdict: "pass", exit: 0, reason: "exit 0" };
  });
  if (scope.outOfScope.length) {
    failed = true;
    reasons.push(`outside writeScope: ${scope.outOfScope.map((p) => p.path).join(", ")}`);
  }
  if (scope.sync.length) {
    blocked = true;
    reasons.push(`同步产物需单独人工提交: ${scope.sync.map((p) => p.path).join(", ")}`);
  }
  if (snapshotChanged) {
    blocked = true;
    reasons.push(`a check wrote to the repository (${newPaths.join(", ") || "status changed"}); confirm that command is still read-only`);
  }
  const verdict = failed ? "fail" : blocked ? "blocked" : "pass";
  return { canOpenPr: verdict === "pass", verdict, reasons, checks: checkResults };
}

/** The three commands, as argv, run from the mono root. Repository arguments are relative to it. */
export function buildChecks(ctx) {
  const tr = normRel(path.relative(ctx.monoRoot, ctx.engine.tr));
  const profile = normRel(path.relative(ctx.monoRoot, ctx.profileFile));
  const sourceRoot = normRel(path.relative(ctx.monoRoot, ctx.sourceRoot));
  return [
    {
      name: "status-verify",
      file: "node",
      args: [tr, "status", "--profile", profile, "--source-root", sourceRoot, "--verify", "--fail-on", FAIL_ON],
    },
    {
      name: "zh-data-audit",
      file: "pnpm",
      args: ["run", "zh:data:repair", "--mode", "audit", "--version", ctx.version, "--repo", ctx.zh.rel],
    },
    {
      name: "docs-verify",
      file: "pnpm",
      args: ["run", "docs:verify", "--dry-run", "--version", ctx.version, "--source-repo", ctx.source.rel, "--zh-repo", ctx.zh.rel],
    },
  ];
}

export function buildContext(opts = {}) {
  const ctx = resolveContext({
    cwd: opts.cwd ?? process.cwd(),
    monoRoot: opts.monoRoot,
    version: opts.version,
    zhRepo: opts.zhRepo,
    sourceRepo: opts.sourceRepo,
  });
  const profile = readProfile(ctx.profileFile);
  const engine = resolveEngine({ skillDir, override: opts.engine, cwd: ctx.monoRoot });
  const syncOutputPaths = ctx.release?.syncOutputPaths ?? [];
  return { ...ctx, profile, engine, sourceRoot: sourceRootOf(ctx.zh.abs, profile), writeScope: writeScopeOf(profile), syncOutputPaths };
}

const keyOf = (e) => `${e.x}${e.y} ${e.path}${e.from ? ` <- ${e.from}` : ""}`;

/** Runs the three checks and returns the verdict. The only writes are to exec's children; `out` is written by the caller. */
export function runGate(ctx, { exec = spawnExec, now = () => new Date().toISOString() } = {}) {
  const before = statusEntries(exec, ctx.zh.abs);
  const checkResults = buildChecks(ctx).map((c) => {
    const r = exec(c.file, c.args, { cwd: ctx.monoRoot });
    return { name: c.name, command: `${c.file} ${c.args.join(" ")}`, exit: r.status ?? null, error: r.error ?? null, stderr: tail(r.stderr) };
  });
  const after = statusEntries(exec, ctx.zh.abs);
  const beforeKeys = new Set(before.map(keyOf));
  const newPaths = after.filter((e) => !beforeKeys.has(keyOf(e))).flatMap(touchedPaths);
  const snapshotChanged = statusDigest(before) !== statusDigest(after);
  const scope = classify(after, { writeScope: ctx.writeScope, syncOutputPaths: ctx.syncOutputPaths });
  const decision = decide({ checks: checkResults, scope, snapshotChanged, newPaths });
  return {
    schema: 1,
    canOpenPr: decision.canOpenPr,
    verdict: decision.verdict,
    reasons: decision.reasons,
    checks: decision.checks.map((c, i) => ({ ...c, command: checkResults[i].command, stderr: checkResults[i].stderr })),
    scope: { inScope: scope.inScope.map((p) => p.path), sync: scope.sync.map((p) => p.path), outOfScope: scope.outOfScope.map((p) => p.path) },
    version: ctx.version,
    versionSource: ctx.versionSource,
    repo: ctx.zh.rel,
    headCommit: headCommit(exec, ctx.zh.abs),
    statusDigest: statusDigest(after),
    generatedAt: now(),
  };
}

const tail = (text, n = 12) => String(text ?? "").trim().split("\n").slice(-n).join("\n");

function formatVerdict(v) {
  const lines = [`## Verification gate: ${v.verdict}`, `canOpenPr: ${v.canOpenPr}`, `version ${v.version} (${v.versionSource})  repo ${v.repo}  HEAD ${v.headCommit.slice(0, 12)}`];
  for (const c of v.checks) lines.push(`  ${c.verdict.padEnd(5)} ${c.name} — ${c.reason}`);
  for (const r of v.reasons) lines.push(`  reason: ${r}`);
  return lines.join("\n");
}

const USAGE = "usage: gate.mjs plan|run [--version vX.Y] [--zh-repo DIR] [--source-repo DIR] [--mono-root DIR] [--engine DIR] [--out FILE] [--json]";

export function main(argv, { exec = spawnExec, out = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv;
  if (!["plan", "run"].includes(command)) {
    err(USAGE);
    return 2;
  }
  try {
    const opts = parseFlags(rest, { boolean: ["json"] });
    if (opts._.length) throw new ConfigError(`unexpected argument ${opts._[0]}\n${USAGE}`);
    const ctx = buildContext({ cwd, monoRoot: opts["mono-root"], version: opts.version, zhRepo: opts["zh-repo"], sourceRepo: opts["source-repo"], engine: opts.engine });
    if (command === "plan") {
      const plan = {
        version: ctx.version,
        versionSource: ctx.versionSource,
        repo: ctx.zh.rel,
        checks: buildChecks(ctx).map((c) => ({ name: c.name, command: `${c.file} ${c.args.join(" ")}` })),
        writeScope: ctx.writeScope,
        syncOutputPaths: ctx.syncOutputPaths,
      };
      out(opts.json ? JSON.stringify(plan, null, 2) : plan.checks.map((c) => `${c.name}: ${c.command}`).join("\n"));
      return 0;
    }
    let outFile = null;
    if (opts.out) {
      outFile = path.resolve(cwd, opts.out);
      if (outFile === ctx.zh.abs || outFile.startsWith(`${ctx.zh.abs}${path.sep}`)) throw new ConfigError(`--out ${outFile} is inside the zh repository; write the verdict outside it so it cannot change the status it describes`);
    }
    const verdict = runGate(ctx, { exec });
    if (outFile) {
      mkdirSync(path.dirname(outFile), { recursive: true });
      writeFileSync(outFile, `${JSON.stringify(verdict, null, 2)}\n`);
    }
    out(opts.json ? JSON.stringify(verdict, null, 2) : formatVerdict(verdict));
    return verdict.canOpenPr ? 0 : 1;
  } catch (error) {
    if (error instanceof ConfigError) {
      err(`gate: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
