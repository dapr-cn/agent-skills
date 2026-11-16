#!/usr/bin/env node
// dapr-docs-translate-incremental — the daily incremental run for a Dapr docs version that is already bootstrapped.
// Deterministic steps only. The translation workflow (next → subagent translation → check → finalize) is driven by the
// main session from dapr-docs-translation/SKILL.md; this script plans it and bounds it, it does not dispatch subagents.
//
//   incremental.mjs plan   [--version vX.Y] [--zh-repo repos/vX.Y_zh] [--mono-root DIR] [--engine DIR] [--json]
//   incremental.mjs run    --phase pre|post [same options] [--json]
//   incremental.mjs commit [same options] [--execute] [--json]
//
// Steps of a run, in order: 1 sync:repos, 2 zh:data:sync, 3 scan (pre); 4 translation workflow by the main session;
// 5 status (post). A failed step stops the run. `commit` is a dry run unless --execute is given.
// Exit codes: 0 ok; 1 a step failed or the commit was refused; 2 usage or configuration error.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError, normRel, parseFlags, readProfile, resolveContext, resolveEngine, sourceRootOf } from "./lib/config.mjs";
import { headCommit as readHead, spawnExec, statusEntries, touchedPaths } from "./lib/git.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, "..");

/** Only these two roots may be committed by this skill. data/, site/ and scripts/ are never committed here. */
export const COMMIT_ROOTS = ["translations/", "translated_content/"];

/** Resolves configuration and the engine. Throws ConfigError on any missing input. */
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
  return { ...ctx, profile, engine, sourceRoot: sourceRootOf(ctx.zh.abs, profile) };
}

const rel = (abs, base) => normRel(path.relative(base, abs));

/** The five-step plan. Commands run from the mono root and use paths relative to it. */
export function buildPlan(ctx) {
  const tr = rel(ctx.engine.tr, ctx.monoRoot);
  const profile = rel(ctx.profileFile, ctx.monoRoot);
  // tr.mjs resolves --source-root against the zh repository, not against the directory it is run from.
  const sourceRoot = rel(ctx.sourceRoot, ctx.zh.abs);
  const steps = [
    { id: 1, kind: "local-write", name: "sync repos", cwd: ".", file: "pnpm", args: ["run", "sync:repos"] },
    {
      id: 2,
      kind: "local-write",
      name: "sync source documents",
      cwd: ".",
      file: "pnpm",
      args: ["run", "zh:data:sync", "--version", ctx.version, "--source-repo", ctx.source.rel, "--zh-repo", ctx.zh.rel],
    },
    { id: 3, kind: "read", name: "scan pending documents", cwd: ".", file: "node", args: [tr, "scan", "--profile", profile, "--source-root", sourceRoot, "--json"] },
    {
      id: 4,
      kind: "agent",
      name: "translate pending documents",
      instruction: "Run the translation workflow in dapr-docs-translation/SKILL.md over the pending list from step 3. Write only under translations/ and translated_content/.",
    },
    { id: 5, kind: "read", name: "status", cwd: ".", file: "node", args: [tr, "status", "--profile", profile, "--source-root", sourceRoot] },
  ];
  return {
    schema: 1,
    version: ctx.version,
    versionSource: ctx.versionSource,
    zhRepo: ctx.zh.rel,
    sourceRoot,
    profile,
    steps,
  };
}

const tail = (text, n = 20) => String(text ?? "").trim().split("\n").slice(-n).join("\n");

/**
 * Runs the pre phase (steps 1–3) or the post phase (step 5). Stops at the first non-zero exit and reports which step failed.
 * After a clean scan with no pending documents the pre phase reports nothingToDo, and the caller still runs post.
 */
export function runPhase(ctx, phase, exec = spawnExec) {
  const plan = buildPlan(ctx);
  const ids = phase === "pre" ? [1, 2, 3] : [5];
  const log = [];
  let scan = null;
  for (const id of ids) {
    const step = plan.steps.find((s) => s.id === id);
    const r = exec(step.file, step.args, { cwd: path.resolve(ctx.monoRoot, step.cwd) });
    log.push({ id, name: step.name, exit: r.status ?? null, error: r.error ?? null });
    if (r.status !== 0) {
      return { ok: false, phase, failedStep: id, failedName: step.name, exitCode: r.status ?? null, error: r.error, stderr: tail(r.stderr), log };
    }
    if (id === 3) {
      try {
        scan = JSON.parse(r.stdout);
      } catch {
        return { ok: false, phase, failedStep: 3, failedName: step.name, exitCode: r.status, error: "scan --json did not print JSON", stderr: tail(r.stdout), log };
      }
    }
  }
  if (phase === "pre") {
    const pending = (scan.pending ?? []).map((d) => ({ doc: d.doc, class: d.class, bytes: d.bytes, tier: d.tier, incremental: d.incremental }));
    return { ok: true, phase, nothingToDo: pending.length === 0, pendingCount: pending.length, pending, summary: scan.summary ?? {}, log };
  }
  return { ok: true, phase, log };
}

/**
 * Plans the commit of changed translations/ and translated_content/ paths only. Anything else that changed is listed
 * as `others`, not committed. Without execute nothing is staged or committed.
 */
export function commitPlan(ctx, { execute = false, exec = spawnExec } = {}) {
  const entries = statusEntries(exec, ctx.zh.abs);
  const scoped = new Set();
  const others = [];
  for (const entry of entries) {
    for (const p of touchedPaths(entry)) {
      if (COMMIT_ROOTS.some((root) => p.startsWith(root))) scoped.add(p);
      else others.push({ path: p, status: `${entry.x}${entry.y}` });
    }
  }
  const paths = [...scoped].sort();
  const prefix = ctx.profile?.commit?.messagePrefix ?? "docs(translation)";
  const message = `${prefix}: ${ctx.version} incremental translation`;
  const commands = paths.length
    ? [
        { file: "git", args: ["add", "-A", "--", ...paths] },
        { file: "git", args: ["commit", "-m", message, "--", ...paths] },
      ]
    : [];
  const result = {
    version: ctx.version,
    repo: ctx.zh.rel,
    message,
    paths,
    others,
    commands: commands.map((c) => `${c.file} ${c.args.join(" ")}`),
    executed: false,
    committed: false,
  };
  if (paths.length === 0) return { ok: true, ...result, note: "no changes under translations/ or translated_content/; no commit" };
  if (!execute) return { ok: true, ...result, note: "dry run: nothing staged or committed (pass --execute to commit)" };
  for (const c of commands) {
    const r = exec(c.file, c.args, { cwd: ctx.zh.abs });
    if (r.status !== 0) return { ok: false, ...result, executed: true, failed: `${c.file} ${c.args.join(" ")}`, stderr: tail(r.stderr) };
  }
  return { ok: true, ...result, executed: true, committed: true, head: readHead(exec, ctx.zh.abs) };
}

function formatPlan(plan) {
  const lines = [
    `## Incremental run plan`,
    `version ${plan.version} (from ${plan.versionSource})  repo ${plan.zhRepo}  sources ${plan.sourceRoot}`,
  ];
  for (const s of plan.steps) {
    lines.push(s.kind === "agent" ? `  ${s.id}. [agent] ${s.name}: ${s.instruction}` : `  ${s.id}. [${s.kind}] ${s.name}: ${[s.file, ...s.args].join(" ")}`);
  }
  return lines.join("\n");
}

const USAGE = `usage: incremental.mjs plan|run --phase pre|post|commit [--version vX.Y] [--zh-repo DIR] [--mono-root DIR] [--engine DIR] [--execute] [--json]`;

export function main(argv, { exec = spawnExec, out = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv;
  if (!["plan", "run", "commit"].includes(command)) {
    err(USAGE);
    return 2;
  }
  try {
    const opts = parseFlags(rest, { boolean: ["execute", "json"] });
    if (opts._.length) throw new ConfigError(`unexpected argument ${opts._[0]}\n${USAGE}`);
    const ctx = buildContext({ cwd, monoRoot: opts["mono-root"], version: opts.version, zhRepo: opts["zh-repo"], engine: opts.engine, sourceRepo: opts["source-repo"] });
    if (command === "plan") {
      const plan = buildPlan(ctx);
      out(opts.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
      return 0;
    }
    if (command === "run") {
      if (!["pre", "post"].includes(opts.phase)) throw new ConfigError(`run needs --phase pre or --phase post\n${USAGE}`);
      const result = runPhase(ctx, opts.phase, exec);
      out(opts.json ? JSON.stringify(result, null, 2) : formatRun(result));
      return result.ok ? 0 : 1;
    }
    const result = commitPlan(ctx, { execute: opts.execute === true, exec });
    out(opts.json ? JSON.stringify(result, null, 2) : formatCommit(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof ConfigError) {
      err(`incremental: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

function formatRun(r) {
  if (!r.ok) return `## Run stopped\nstep ${r.failedStep} (${r.failedName}) failed with exit ${r.exitCode ?? "none"}${r.error ? `: ${r.error}` : ""}\n${r.stderr}`;
  if (r.phase === "post") return "## Status step finished (step 5)";
  if (r.nothingToDo) return "## Pre phase finished: 无待办 (nothing pending). Skip the translation workflow and run --phase post.";
  return `## Pre phase finished: ${r.pendingCount} pending document(s). Run the translation workflow (step 4), then --phase post.`;
}

function formatCommit(r) {
  const lines = [r.note ?? (r.committed ? `committed ${r.paths.length} path(s)` : "not committed")];
  for (const p of r.paths) lines.push(`  + ${p}`);
  for (const o of r.others) lines.push(`  ! not committed (${o.status}): ${o.path}`);
  if (r.failed) lines.push(`failed: ${r.failed}\n${r.stderr}`);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
