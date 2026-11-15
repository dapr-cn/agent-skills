#!/usr/bin/env node
// dapr-docs-upstream-pr — offers a verified translation upstream, in confirmed stages.
// Nothing runs without a fresh, passing verdict from dapr-docs-translation-verify (--gate). The default is a plan.
//   Stage A  A1 normal push of vX.Y_content to the translation remote (dapr/docs-zh).   Optional A2: PR on dapr/docs-zh.
//   Stage B  B1 fast-forward the upstream branch in repos/fork-docs; B2 point translations/docs-zh at the pushed commit on a
//            work branch; B3 npm ci && npm run build, then write the PR text to --out.
//            B4 push the work branch to the fork and B5 open the PR against dapr/docs are separate confirmations.
// Stage B starts only when the target commit is already on the translation remote.
//
//   upstream-pr.mjs plan  --gate verdict.json [--version vX.Y] [--zh-repo DIR] [--mono-root DIR] [--out DIR]
//                         [--max-age-minutes 30] [--zh-pr-base BRANCH] [--json]
//   upstream-pr.mjs apply (--stage A|B | --step A1|A2|B1|B2|B3|B4|B5) [--execute --confirm HASH] [same options] [--json]
//
// Exit codes: 0 ok (or dry run); 1 refused or a step failed; 2 usage or configuration error; 3 --confirm does not match the plan.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError, findMonoRoot, loadMonospecs, normRel, parseFlags, readRelease, repoRef, VERSION_RE } from "./lib/config.mjs";
import { checkConfirm, planHash } from "./lib/guard.mjs";
import { headCommit as readHead, spawnExec, statusDigest, statusEntries } from "./lib/git.mjs";

const tail = (text, n = 12) => String(text ?? "").trim().split("\n").slice(-n).join("\n");

/** `git ls-remote --heads` output as [{ name, sha }]. Inlined on purpose: each skill is standalone. */
export function parseHeads(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref = ""] = line.split(/\s+/);
      return { sha, name: ref.replace(/^refs\/heads\//, "") };
    })
    .filter((b) => b.sha && b.name);
}

/**
 * Decides whether a verdict may be used now. A stale, mismatched or failed verdict is refused with its reasons.
 * A refused verdict yields no steps and no confirmation value.
 */
export function checkGate(verdict, { now = Date.now(), currentHead, currentDigest, maxAgeMinutes = 30, version, repo } = {}) {
  const reasons = [];
  if (!verdict || typeof verdict !== "object") return { ok: false, reasons: ["the gate verdict is not an object"] };
  if (verdict.canOpenPr !== true) {
    reasons.push(`the gate did not pass (verdict ${verdict.verdict ?? "unknown"}, canOpenPr ${verdict.canOpenPr}); fix what it lists and run dapr-docs-translation-verify again`);
  }
  if (verdict.headCommit !== currentHead) {
    reasons.push(`the verdict's headCommit ${String(verdict.headCommit).slice(0, 12)} is not the current HEAD ${currentHead.slice(0, 12)}; re-run the gate`);
  }
  if (verdict.statusDigest !== currentDigest) reasons.push("the working tree status changed after the gate ran; re-run the gate");
  if (version !== undefined && verdict.version !== version) reasons.push(`the verdict is for ${verdict.version}, not ${version}`);
  if (repo !== undefined && verdict.repo !== repo) reasons.push(`the verdict is for ${verdict.repo}, not ${repo}`);
  const at = Date.parse(verdict.generatedAt);
  if (!Number.isFinite(at)) reasons.push("the verdict has no valid generatedAt");
  else if (now - at > maxAgeMinutes * 60_000) reasons.push(`the verdict is older than ${maxAgeMinutes} minutes; re-run the gate`);
  else if (at - now > 60_000) reasons.push("the verdict's generatedAt is in the future");
  return { ok: reasons.length === 0, reasons };
}

const specOf = (s) => ({
  stepId: s.id,
  kind: s.kind,
  remote: s.remote ?? null,
  branch: s.branch ?? null,
  targetCommit: s.targetCommit ?? null,
  command: s.commands,
});
export const stepHash = (s) => planHash(specOf(s));
const stageHash = (stage, steps) => planHash({ stage, steps: steps.map(specOf) });

/** owner/repo of a github URL, or null. */
export function githubRepo(url) {
  const m = String(url ?? "").match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Resolves version, repositories and release. Throws ConfigError when anything needed is missing or invalid. */
export function buildContext(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const monoRoot = opts.monoRoot ? path.resolve(opts.monoRoot) : findMonoRoot(cwd);
  if (opts.version !== undefined && !VERSION_RE.test(opts.version)) throw new ConfigError(`--version "${opts.version}" must look like vX.Y`);
  if (opts.version === undefined && opts.zhRepo === undefined) throw new ConfigError("no version: pass --version vX.Y, or --zh-repo whose translations/release.yaml names it");
  const zh = repoRef(monoRoot, opts.zhRepo ?? `repos/${opts.version}_zh`);
  const release = readRelease(path.join(zh.abs, "translations", "release.yaml"));
  if (!release) throw new ConfigError(`no translations/release.yaml in ${zh.rel}`);
  if (!release.valid) throw new ConfigError(`${zh.rel}/translations/release.yaml is invalid (${[...release.missing.map((m) => `missing ${m}`), ...release.problems].join("; ")})`);
  const version = opts.version ?? release.value.version;
  if (version !== release.value.version) throw new ConfigError(`--version ${version} does not match ${zh.rel}/translations/release.yaml (${release.value.version})`);
  const zhUrl = loadMonospecs(monoRoot).find((r) => normRel(r.path ?? "") === zh.rel)?.url;
  if (!zhUrl) throw new ConfigError(`no monospecs entry with the URL of ${zh.rel}`);
  const fork = release.value.upstreamPr.forkDocs;
  const forkRepo = repoRef(monoRoot, fork.path);
  return {
    monoRoot,
    version,
    zh,
    zhUrl,
    fork,
    forkAbs: forkRepo.abs,
    forkRel: forkRepo.rel,
    workBranch: `translations-${version}`,
    contentBranch: `${version}_content`,
    prBase: opts.zhPrBase ?? null,
    out: opts.out ? path.resolve(cwd, opts.out) : null,
    maxAgeMinutes: opts.maxAgeMinutes ?? 30,
    exec: opts.exec ?? spawnExec,
  };
}

function lsRemote(exec, cwd, url, ref) {
  const r = exec("git", ["ls-remote", "--heads", url, ...(ref ? [ref] : [])], { cwd });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.error || `exit ${r.status}`).trim() };
  return { ok: true, branches: parseHeads(r.stdout) };
}

const headOf = (branches, name) => branches.find((b) => b.name === name)?.sha ?? null;

/**
 * The whole plan. Probes only (ls-remote, rev-parse, status, origin lookups); nothing is written.
 */
export function buildPlan(ctx, verdict, { now = Date.now() } = {}) {
  const exec = ctx.exec;
  const head = readHead(exec, ctx.zh.abs);
  const digest = statusDigest(statusEntries(exec, ctx.zh.abs));
  const gate = checkGate(verdict, { now, currentHead: head, currentDigest: digest, maxAgeMinutes: ctx.maxAgeMinutes, version: ctx.version, repo: ctx.zh.rel });
  const plan = { schema: 1, version: ctx.version, gate: { ok: gate.ok, reasons: gate.reasons, headCommit: head, statusDigest: digest }, steps: [], stages: {} };
  if (!gate.ok) return plan;
  const refuse = (reason) => ({ ...plan, gate: { ...plan.gate, ok: false, reasons: [reason] } });

  const onBranch = exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.zh.abs }).stdout.trim();
  if (onBranch !== ctx.contentBranch) return refuse(`the translation repo is on ${onBranch}, expected ${ctx.contentBranch}`);
  const zhRemote = lsRemote(exec, ctx.zh.abs, ctx.zhUrl);
  if (!zhRemote.ok) return refuse(`cannot reach ${ctx.zhUrl}: ${zhRemote.error}`);
  const upstreamUrl = ctx.fork.upstreamUrl;
  const upstream = lsRemote(exec, ctx.zh.abs, upstreamUrl, `refs/heads/${ctx.fork.upstreamBranch}`);
  if (!upstream.ok) return refuse(`cannot reach ${upstreamUrl}: ${upstream.error}`);
  const upstreamSha = headOf(upstream.branches, ctx.fork.upstreamBranch);
  if (!upstreamSha) return refuse(`${upstreamUrl} has no branch ${ctx.fork.upstreamBranch}`);
  if (!existsSync(path.join(ctx.forkAbs, ".git"))) return refuse(`${ctx.forkRel} is not a checkout`);

  const git = (cwd, args) => {
    const r = exec("git", args, { cwd });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
  };
  const origin = git(ctx.forkAbs, ["remote", "get-url", "origin"]).out;
  const forkOwner = githubRepo(origin)?.split("/")[0] ?? "<fork-owner>";
  const upstreamRepo = githubRepo(upstreamUrl) ?? upstreamUrl;
  const zhRepo = githubRepo(ctx.zhUrl) ?? ctx.zhUrl;
  const localUp = git(ctx.forkAbs, ["rev-parse", "--verify", "--quiet", `refs/heads/${ctx.fork.upstreamBranch}`]);
  const currentFork = git(ctx.forkAbs, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const subAbs = path.join(ctx.forkAbs, ctx.fork.submodulePath);
  const subHead = existsSync(subAbs) ? git(subAbs, ["rev-parse", "HEAD"]).out : "";
  const workLocal = git(ctx.forkAbs, ["rev-parse", "--verify", "--quiet", `refs/heads/${ctx.workBranch}`]);
  const originHeads = origin ? lsRemote(exec, ctx.forkAbs, origin) : { ok: false };
  const workRemote = originHeads.ok ? headOf(originHeads.branches, ctx.workBranch) : null;
  const outDir = ctx.out ?? "<out>";
  const steps = [];
  steps.push({
    id: "A1",
    kind: "public-push",
    name: `push ${ctx.contentBranch} to ${zhRepo}`,
    stage: "A",
    requires: null,
    done: headOf(zhRemote.branches, ctx.contentBranch) === head,
    remote: ctx.zhUrl,
    branch: ctx.contentBranch,
    targetCommit: head,
    commands: [`git push ${ctx.zhUrl} ${ctx.contentBranch}  (normal push, never --force)`],
    argv: { cwd: ctx.zh.abs, file: "git", args: ["push", ctx.zhUrl, ctx.contentBranch] },
  });
  if (ctx.prBase) {
    steps.push({
      id: "A2",
      kind: "public-pr",
      name: `open a PR on ${zhRepo} from ${ctx.contentBranch} into ${ctx.prBase}`,
      stage: null,
      requires: "A1",
      done: false,
      remote: ctx.zhUrl,
      branch: ctx.contentBranch,
      targetCommit: head,
      commands: [`gh pr create --repo ${zhRepo} --base ${ctx.prBase} --head ${ctx.contentBranch} --fill`],
      argv: { cwd: ctx.zh.abs, file: "gh", args: ["pr", "create", "--repo", zhRepo, "--base", ctx.prBase, "--head", ctx.contentBranch, "--fill"] },
    });
  }
  steps.push({
    id: "B1",
    kind: "local-write",
    name: `fast-forward ${ctx.fork.upstreamBranch} in ${ctx.forkRel} to ${upstreamRepo}`,
    stage: "B",
    requires: "A1",
    done: localUp.ok && localUp.out === upstreamSha,
    remote: upstreamUrl,
    branch: ctx.fork.upstreamBranch,
    targetCommit: upstreamSha,
    commands: [
      `git remote add upstream ${upstreamUrl}  (only if no upstream remote exists)`,
      `git fetch upstream ${ctx.fork.upstreamBranch}`,
      `git update-ref refs/heads/${ctx.fork.upstreamBranch} <upstream sha> <current sha>  (only when the current sha is an ancestor)`,
    ],
  });
  steps.push({
    id: "B2",
    kind: "branch-create",
    name: `create ${ctx.workBranch} and point ${ctx.fork.submodulePath} at ${ctx.contentBranch}`,
    stage: "B",
    requires: "B1",
    done: currentFork === ctx.workBranch && subHead === head,
    remote: ctx.zhUrl,
    branch: ctx.contentBranch,
    targetCommit: head,
    commands: [
      `git switch -c ${ctx.workBranch} ${ctx.fork.upstreamBranch}  (or switch to it when it exists)`,
      `git submodule update --init -- ${ctx.fork.submodulePath}`,
      `git -C ${ctx.fork.submodulePath} fetch ${ctx.zhUrl} ${ctx.contentBranch}; git -C ${ctx.fork.submodulePath} checkout --detach ${head}`,
      `git commit -m "<messagePrefix>: sync ${ctx.version} translations" -- ${ctx.fork.submodulePath}`,
    ],
  });
  // B3 is done when the PR text for this exact translation commit already sits in --out (written after a passing build)
  const draftBody = ctx.out ? path.join(ctx.out, "body.md") : null;
  const draftDone = !!draftBody && existsSync(draftBody) && readFileSync(draftBody, "utf8").includes(head.slice(0, 12));
  steps.push({
    id: "B3",
    kind: "local-write",
    name: `build ${ctx.forkRel} and write the PR text to ${outDir}`,
    stage: "B",
    requires: "B2",
    done: draftDone,
    commands: ["npm ci", "npm run build", `write ${outDir}/title.txt and ${outDir}/body.md`],
  });
  steps.push({
    id: "B4",
    kind: "public-push",
    name: `push ${ctx.workBranch} to the fork`,
    stage: null,
    requires: "B3",
    done: !!workRemote && workRemote === (workLocal.ok ? workLocal.out : null),
    remote: origin,
    branch: ctx.workBranch,
    targetCommit: workLocal.ok ? workLocal.out : null,
    commands: [`git push origin ${ctx.workBranch}  (normal push, never --force)`],
    argv: { cwd: ctx.forkAbs, file: "git", args: ["push", "origin", ctx.workBranch] },
  });
  steps.push({
    id: "B5",
    kind: "public-pr",
    name: `open the PR against ${upstreamRepo} (${ctx.fork.upstreamBranch})`,
    stage: null,
    requires: "B4",
    done: false,
    remote: upstreamUrl,
    branch: ctx.fork.upstreamBranch,
    targetCommit: workLocal.ok ? workLocal.out : null,
    head: `${forkOwner}:${ctx.workBranch}`,
    commands: [
      `gh pr create --repo ${upstreamRepo} --base ${ctx.fork.upstreamBranch} --head ${forkOwner}:${ctx.workBranch} --title-file ${outDir}/title.txt --body-file ${outDir}/body.md`,
    ],
  });
  plan.steps = steps;
  for (const id of ["A", "B"]) {
    const members = steps.filter((s) => s.stage === id);
    plan.stages[id] = { steps: members.map((s) => s.id), hash: stageHash(id, members) };
  }
  plan.target = { upstreamSha, zhUrl: ctx.zhUrl, upstreamUrl, origin, workBranch: ctx.workBranch, contentSha: head };
  return plan;
}

/** Runs one step after its confirmation has matched. Returns { ok, log, error, report }. */
export function runStep(ctx, plan, s) {
  const exec = ctx.exec;
  const log = [];
  const run = (file, args, cwd) => {
    const r = exec(file, args, { cwd });
    log.push({ cmd: `${file} ${args.join(" ")}`, exit: r.status ?? null });
    return r;
  };
  const fail = (r, what) => ({ ok: false, log, error: `${what}: ${tail(r.stderr) || r.error || `exit ${r.status}`}` });
  const forkCwd = ctx.forkAbs;

  if (s.id === "B1") {
    if (run("git", ["remote", "get-url", "upstream"], forkCwd).status !== 0) {
      const add = run("git", ["remote", "add", "upstream", ctx.fork.upstreamUrl], forkCwd);
      if (add.status !== 0) return fail(add, "B1 remote add");
    }
    const fetch = run("git", ["fetch", "upstream", ctx.fork.upstreamBranch], forkCwd);
    if (fetch.status !== 0) return fail(fetch, "B1 fetch");
    const old = run("git", ["rev-parse", "--verify", `refs/heads/${ctx.fork.upstreamBranch}`], forkCwd);
    if (old.status !== 0) return { ok: false, log, error: `B1: ${ctx.forkRel} has no local ${ctx.fork.upstreamBranch}` };
    const oldSha = old.stdout.trim();
    if (run("git", ["merge-base", "--is-ancestor", oldSha, s.targetCommit], forkCwd).status !== 0) {
      return { ok: false, log, error: `B1: ${ctx.forkRel} ${ctx.fork.upstreamBranch} has diverged from upstream; nothing merged or reset` };
    }
    const upd = run("git", ["update-ref", `refs/heads/${ctx.fork.upstreamBranch}`, s.targetCommit, oldSha], forkCwd);
    return upd.status === 0 ? { ok: true, log } : fail(upd, "B1 update-ref");
  }
  if (s.id === "B2") {
    const exists = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${ctx.workBranch}`], forkCwd).status === 0;
    const sw = exists ? run("git", ["switch", ctx.workBranch], forkCwd) : run("git", ["switch", "-c", ctx.workBranch, ctx.fork.upstreamBranch], forkCwd);
    if (sw.status !== 0) return fail(sw, "B2 switch");
    const sub = run("git", ["submodule", "update", "--init", "--", ctx.fork.submodulePath], forkCwd);
    if (sub.status !== 0) return fail(sub, "B2 submodule");
    const subAbs = path.join(forkCwd, ctx.fork.submodulePath);
    const f = run("git", ["fetch", ctx.zhUrl, ctx.contentBranch], subAbs);
    if (f.status !== 0) return fail(f, "B2 fetch translations");
    const co = run("git", ["checkout", "--detach", s.targetCommit], subAbs);
    if (co.status !== 0) return fail(co, "B2 checkout");
    if (run("git", ["add", "--", ctx.fork.submodulePath], forkCwd).status !== 0) return { ok: false, log, error: "B2: git add failed" };
    if (run("git", ["diff", "--cached", "--quiet", "--", ctx.fork.submodulePath], forkCwd).status === 0) {
      return { ok: true, log, note: "submodule already at the target commit; nothing to commit" };
    }
    const commit = run("git", ["commit", "-m", `docs(translation): sync ${ctx.version} translations`, "--", ctx.fork.submodulePath], forkCwd);
    return commit.status === 0 ? { ok: true, log } : fail(commit, "B2 commit");
  }
  if (s.id === "B3") {
    if (!ctx.out) return { ok: false, log, error: "B3 needs --out <dir> for the PR text" };
    const ci = run("npm", ["ci"], forkCwd);
    if (ci.status !== 0) return fail(ci, "B3 npm ci");
    const build = run("npm", ["run", "build"], forkCwd);
    if (build.status !== 0) return { ok: false, log, error: `B3 build failed; no PR text was written. ${tail(build.stderr) || build.error || ""}` };
    mkdirSync(ctx.out, { recursive: true });
    const title = `docs: sync Chinese translations for ${ctx.version}`;
    const body = [
      `Translations for Dapr docs ${ctx.version}, from ${ctx.zh.rel} at ${plan.target.contentSha.slice(0, 12)}.`,
      "",
      "Checked by dapr-docs-translation-verify before this pull request was prepared.",
    ].join("\n");
    writeFileSync(path.join(ctx.out, "title.txt"), `${title}\n`);
    writeFileSync(path.join(ctx.out, "body.md"), `${body}\n`);
    return { ok: true, log, report: { title: path.join(ctx.out, "title.txt"), body: path.join(ctx.out, "body.md") } };
  }
  if (s.id === "B5") {
    if (!ctx.out) return { ok: false, log, error: "B5 needs --out with the PR text from B3" };
    const r = run("gh", ["pr", "create", "--repo", githubRepo(ctx.fork.upstreamUrl) ?? ctx.fork.upstreamUrl, "--base", ctx.fork.upstreamBranch, "--head", s.head, "--title-file", path.join(ctx.out, "title.txt"), "--body-file", path.join(ctx.out, "body.md")], forkCwd);
    return r.status === 0 ? { ok: true, log, report: { pr: (r.stdout ?? "").trim() } } : fail(r, "B5 gh pr create");
  }
  if (s.argv) {
    const r = run(s.argv.file, s.argv.args, s.argv.cwd);
    return r.status === 0 ? { ok: true, log } : fail(r, s.id);
  }
  return { ok: false, log, error: `no action for ${s.id}` };
}

/**
 * apply: a dry run unless --execute is given. With --execute the named stage or step runs only when --confirm equals its
 * current hash. A stage's members run in order and stop at the first failure.
 */
export function apply(ctx, verdict, { stage, stepId, execute = false, confirm, now = Date.now() } = {}) {
  const plan = buildPlan(ctx, verdict, { now });
  if (!plan.gate.ok) return { ok: false, code: 1, reason: `gate refused: ${plan.gate.reasons.join("; ")}`, reasons: plan.gate.reasons };
  let members;
  let expected;
  let label;
  if (stage) {
    if (!plan.stages[stage]) return { ok: false, code: 2, reason: `unknown stage "${stage}" (use A or B)` };
    members = plan.steps.filter((s) => s.stage === stage);
    expected = plan.stages[stage].hash;
    label = `stage ${stage}`;
    if (stage === "B") {
      const onRemote = lsRemote(ctx.exec, ctx.zh.abs, ctx.zhUrl);
      if (!onRemote.ok) return { ok: false, code: 1, reason: `cannot reach ${ctx.zhUrl}: ${onRemote.error}` };
      if (headOf(onRemote.branches, ctx.contentBranch) !== plan.target.contentSha) {
        return { ok: false, code: 1, reason: `${ctx.contentBranch} at ${plan.target.contentSha.slice(0, 12)} is not on ${ctx.zhUrl} yet; run stage A first` };
      }
    }
  } else {
    const s = plan.steps.find((x) => x.id === stepId);
    if (!s) return { ok: false, code: 2, reason: `unknown step "${stepId}" (use A1, A2, B1 to B5)` };
    members = [s];
    expected = stepHash(s);
    label = `step ${s.id}`;
  }
  for (const s of members) {
    if (s.done || !s.requires) continue;
    const pre = plan.steps.find((x) => x.id === s.requires);
    const satisfied = pre.done || members.some((m) => m.id === pre.id);
    if (!satisfied) return { ok: false, code: 1, step: s.id, reason: `${pre.id} must be done before ${s.id}` };
  }
  const pending = members.filter((s) => !s.done);
  if (!execute) {
    return { ok: true, code: 0, dryRun: true, label, hash: expected, steps: pending.map((s) => ({ id: s.id, hash: stepHash(s), commands: s.commands })), plan };
  }
  if (pending.length === 0) return { ok: true, code: 0, label, note: "already done; nothing to run", plan };
  const check = checkConfirm({ stepId: label, expected, given: confirm });
  if (!check.ok) return { ok: false, code: check.code, label, hash: expected, reason: check.reason, plan };
  const log = [];
  for (const s of pending) {
    const r = runStep(ctx, plan, s);
    log.push({ step: s.id, ok: r.ok, note: r.note, report: r.report, error: r.error, commands: r.log });
    if (!r.ok) return { ok: false, code: 1, label, failed: s.id, error: r.error, log, plan };
  }
  return { ok: true, code: 0, label, hash: expected, executed: pending.map((s) => s.id), log, plan };
}

function formatPlan(plan) {
  const lines = [`## Upstream PR plan: ${plan.version}`];
  if (!plan.gate.ok) {
    lines.push("Refused: the verification gate does not allow this yet.");
    for (const r of plan.gate.reasons) lines.push(`  - ${r}`);
    return lines.join("\n");
  }
  lines.push(`gate passed at HEAD ${plan.gate.headCommit.slice(0, 12)}`);
  for (const s of plan.steps) {
    lines.push(`${s.id} [${s.kind}] ${s.done ? "done" : "todo"}  ${s.name}  hash ${stepHash(s)}`);
    for (const c of s.commands) lines.push(`      ${c}`);
  }
  for (const [id, st] of Object.entries(plan.stages)) lines.push(`stage ${id}: ${st.steps.join(", ")}  hash ${st.hash}`);
  return lines.join("\n");
}

const USAGE = "usage: upstream-pr.mjs plan|apply --gate verdict.json [--stage A|B | --step <id>] [--execute --confirm HASH] [--out DIR] [--version vX.Y] [--zh-repo DIR] [--mono-root DIR] [--zh-pr-base BRANCH] [--max-age-minutes N] [--json]";

export function main(argv, { out = console.log, err = console.error, cwd = process.cwd(), exec = spawnExec } = {}) {
  const [command, ...rest] = argv;
  if (!["plan", "apply"].includes(command)) {
    err(USAGE);
    return 2;
  }
  try {
    const opts = parseFlags(rest, { boolean: ["execute", "json"] });
    if (opts._.length) throw new ConfigError(`unexpected argument ${opts._[0]}\n${USAGE}`);
    if (!opts.gate) throw new ConfigError(`${command} needs --gate verdict.json (the output of dapr-docs-translation-verify run --out)\n${USAGE}`);
    let verdict;
    try {
      verdict = JSON.parse(readFileSync(path.resolve(cwd, opts.gate), "utf8"));
    } catch (error) {
      throw new ConfigError(`cannot read --gate ${opts.gate}: ${error.message}`);
    }
    const maxAge = opts["max-age-minutes"] === undefined ? 30 : Number(opts["max-age-minutes"]);
    if (!Number.isFinite(maxAge) || maxAge <= 0) throw new ConfigError("--max-age-minutes must be a positive number");
    const ctx = buildContext({
      cwd,
      monoRoot: opts["mono-root"],
      version: opts.version,
      zhRepo: opts["zh-repo"],
      zhPrBase: opts["zh-pr-base"],
      out: opts.out,
      maxAgeMinutes: maxAge,
      exec,
    });
    if (command === "plan") {
      const plan = buildPlan(ctx, verdict);
      out(opts.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
      return plan.gate.ok ? 0 : 1;
    }
    if (!opts.stage && !opts.step) throw new ConfigError(`apply needs --stage A|B or --step <id>\n${USAGE}`);
    const result = apply(ctx, verdict, { stage: opts.stage, stepId: opts.step, execute: opts.execute === true, confirm: opts.confirm, now: Date.now() });
    if (opts.json) out(JSON.stringify(result, null, 2));
    else {
      const lines = [result.ok ? `${result.label ?? "apply"}: ${result.note ?? (result.executed ? `executed ${result.executed.join(", ")}` : result.dryRun ? "dry run" : "ok")}` : `refused: ${result.reason ?? result.error}`];
      if (result.hash) lines.push(`plan hash ${result.hash}`);
      for (const s of result.steps ?? []) lines.push(`  ${s.id} hash ${s.hash}`, ...s.commands.map((c) => `      ${c}`));
      if (result.failed) lines.push(`failed at ${result.failed}: ${result.error}`);
      out(lines.join("\n"));
    }
    return result.code;
  } catch (error) {
    if (error instanceof ConfigError) {
      err(`upstream-pr: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
