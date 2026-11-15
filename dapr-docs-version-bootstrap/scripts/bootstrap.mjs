#!/usr/bin/env node
// dapr-docs-version-bootstrap — brings a new Dapr docs version vX.Y into the translation workflow.
// The new translation branch is cut from the previous version's translation branch, so translations/ (ledger, glossary,
// baseline copies) and translated_content/ come along. `tr.mjs adopt` is never used: adopted documents have no baseline.
//
//   bootstrap.mjs plan  --version vX.Y [--previous vP] [--source-url URL] [--zh-url URL] [--mono-root DIR] [--engine DIR] [--json]
//   bootstrap.mjs apply --version vX.Y --step S<n> [--execute --confirm <hash>] [same options] [--json]
//
// Steps: S0 probe remotes (read) · S1 clone upstream vX.Y · S2 clone previous vP_content · S3 create vX.Y_content ·
// S4 append monospecs entries · S5 write profile + release.yaml and commit them · S6 zh:data:sync + scan report ·
// S7 normal push of vX.Y_content (only with its own confirmation; dapr-docs-upstream-pr normally pushes it).
// Every step except S0 is dry-run by default. --execute with the matching --confirm <hash> runs exactly that one step.
// Exit codes: 0 ok (or dry run); 1 refused or a step failed; 2 usage or configuration error; 3 --confirm does not match the plan.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError, MONOSPECS, VERSION_RE, findMonoRoot, loadMonospecs, normRel, parseFlags, readRelease, resolveEngine, validateRelease } from "./lib/config.mjs";
import { checkConfirm, planHash } from "./lib/guard.mjs";
import { headCommit as readHead, spawnExec } from "./lib/git.mjs";
import { branchNamed, classifyBranches, compareVersions, parseLsRemote, pickPrevious } from "./branches.mjs";
import { appendEntries, entryPaths } from "./monospecs-edit.mjs";
import { parseYaml } from "./lib/yaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, "..");
export const STEP_IDS = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const fileSha = (file) => (existsSync(file) ? sha256(readFileSync(file, "utf8")) : null);
const tail = (text, n = 12) => String(text ?? "").trim().split("\n").slice(-n).join("\n");

/** Resolves the mono root, the URLs (from monospecs unless given) and the engine. Throws ConfigError when anything is missing. */
export function buildContext(opts = {}) {
  const monoRoot = opts.monoRoot ? path.resolve(opts.monoRoot) : findMonoRoot(opts.cwd ?? process.cwd());
  const version = opts.version;
  if (!VERSION_RE.test(version ?? "")) throw new ConfigError(`--version vX.Y is required (got "${version ?? ""}")`);
  if (opts.previous !== undefined && !VERSION_RE.test(opts.previous)) throw new ConfigError(`--previous "${opts.previous}" must look like vX.Y`);
  const specs = loadMonospecs(monoRoot);
  const latest = (re) => {
    const found = specs
      .map((r) => ({ v: (String(r.path ?? "").match(re) ?? [])[1], url: r.url }))
      .filter((c) => c.v && c.url)
      .sort((a, b) => compareVersions(a.v, b.v));
    return found.length ? found[found.length - 1].url : null;
  };
  const sourceUrl = opts.sourceUrl ?? latest(/^repos\/(v\d+\.\d+)$/);
  const zhUrl = opts.zhUrl ?? latest(/^repos\/(v\d+\.\d+)_zh$/);
  if (!sourceUrl) throw new ConfigError(`no repos/vX.Y entry in ${MONOSPECS} to take the upstream URL from; pass --source-url`);
  if (!zhUrl) throw new ConfigError(`no repos/vX.Y_zh entry in ${MONOSPECS} to take the translation URL from; pass --zh-url`);
  const engine = resolveEngine({ skillDir, override: opts.engine, cwd: monoRoot });
  return {
    monoRoot,
    version,
    previous: opts.previous ?? null,
    sourceUrl,
    zhUrl,
    specs,
    engine,
    exec: opts.exec ?? spawnExec,
    src: `repos/${version}`,
    zh: `repos/${version}_zh`,
    contentBranch: `${version}_content`,
  };
}

function lsRemote(exec, cwd, url) {
  const r = exec("git", ["ls-remote", "--heads", url], { cwd });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.error || `exit ${r.status}`).trim() };
  return { ok: true, branches: parseLsRemote(r.stdout) };
}

const entryUrl = (specs, rel) => specs.find((r) => normRel(r.path ?? "") === rel)?.url ?? null;

/** Updates only the version-related fields of profile.yaml text: repo, and sources.description. Everything else is kept. */
export function updateProfileText(text, { oldVersion, newVersion }) {
  const lines = text.split("\n");
  const changed = [];
  const repoIdx = lines.findIndex((l) => /^repo:/.test(l));
  const wanted = `repo: "repos/${newVersion}_zh"`;
  if (repoIdx >= 0) {
    const next = lines[repoIdx].replace(/^repo:\s*"[^"]*"/, wanted);
    if (next !== lines[repoIdx]) {
      lines[repoIdx] = next;
      changed.push("repo");
    }
  }
  const sourcesIdx = lines.findIndex((l) => /^sources:\s*$/.test(l));
  for (let i = sourcesIdx + 1; sourcesIdx >= 0 && i < lines.length && (lines[i] === "" || /^\s/.test(lines[i])); i += 1) {
    if (/^\s+description:/.test(lines[i]) && lines[i].includes(oldVersion)) {
      lines[i] = lines[i].split(oldVersion).join(newVersion);
      changed.push("sources.description");
      break;
    }
  }
  return { text: lines.join("\n"), changed };
}

/** The release.yaml for a new version, written from the inherited one when it is valid, otherwise from the convention. */
export function renderRelease({ version, previousVersion, upstreamUrl, forkDocs }) {
  return [
    "# release.yaml — generated by dapr-docs-version-bootstrap. Maintained by hand from now on; the skills never rewrite it.",
    "schema: 1",
    `version: ${version}`,
    `previousVersion: ${previousVersion}`,
    "syncOutputPaths:",
    "  - data/",
    "upstreamPr:",
    "  forkDocs:",
    `    path: ${forkDocs.path}`,
    `    submodulePath: ${forkDocs.submodulePath}`,
    `    upstreamUrl: ${upstreamUrl}`,
    `    upstreamBranch: ${version}`,
    "",
  ].join("\n");
}

function step(id, kind, name, fields) {
  return { id, kind, name, done: false, requires: null, commands: [], ...fields };
}

/** The whole plan. Only `ls-remote` runs here, so a dry run changes nothing. */
export function buildPlan(ctx) {
  const V = ctx.version;
  const plan = { schema: 1, version: V, previous: null, sourceUrl: ctx.sourceUrl, zhUrl: ctx.zhUrl, stopped: null, steps: [] };
  const up = lsRemote(ctx.exec, ctx.monoRoot, ctx.sourceUrl);
  if (!up.ok) return { ...plan, stopped: `cannot reach upstream ${ctx.sourceUrl}: ${up.error}` };
  const zh = lsRemote(ctx.exec, ctx.monoRoot, ctx.zhUrl);
  if (!zh.ok) return { ...plan, stopped: `cannot reach translation remote ${ctx.zhUrl}: ${zh.error}` };
  const upClass = classifyBranches(up.branches);
  const zhClass = classifyBranches(zh.branches);
  if (!upClass.docs.includes(V)) return { ...plan, stopped: `upstream ${ctx.sourceUrl} has no branch ${V}` };
  if (ctx.previous && !zhClass.content.includes(ctx.previous)) {
    return { ...plan, stopped: `--previous ${ctx.previous} has no ${ctx.previous}_content branch on ${ctx.zhUrl}` };
  }
  const previous = ctx.previous ?? pickPrevious({ target: V, contentVersions: zhClass.content });
  if (!previous) return { ...plan, stopped: `no earlier version has a translation (_content) branch on ${ctx.zhUrl}` };
  plan.previous = previous;

  const zhAbs = path.join(ctx.monoRoot, ctx.zh);
  const srcAbs = path.join(ctx.monoRoot, ctx.src);
  const localUp = existsSync(path.join(srcAbs, ".git"));
  const localZh = existsSync(path.join(zhAbs, ".git"));
  const localBranch = localZh && spawnBranchExists(ctx, zhAbs, ctx.contentBranch);
  if (branchNamed(zh.branches, ctx.contentBranch) && !localZh) {
    return { ...plan, stopped: `${ctx.zhUrl} already has ${ctx.contentBranch}; a local clone is needed to resume` };
  }
  const prevUp = entryUrl(ctx.specs, `repos/${previous}`) ?? ctx.sourceUrl;
  const prevZh = entryUrl(ctx.specs, `repos/${previous}_zh`) ?? ctx.zhUrl;
  const monospecsFile = path.join(ctx.monoRoot, MONOSPECS);
  const headZh = localZh ? readHead(ctx.exec, zhAbs) : null;
  const remoteZhBranch = branchNamed(zh.branches, ctx.contentBranch);

  const steps = [];
  steps.push(step("S0", "read", "probe remotes", { done: true, commands: [`git ls-remote --heads ${ctx.sourceUrl}`, `git ls-remote --heads ${ctx.zhUrl}`] }));
  steps.push(
    step("S1", "local-write", `clone upstream ${V}`, {
      requires: "S0",
      done: localUp,
      remote: ctx.sourceUrl,
      branch: V,
      targetCommit: branchNamed(up.branches, V).sha,
      commands: [`git clone --branch ${V} ${ctx.sourceUrl} ${ctx.src}`],
      argv: { cwd: ctx.monoRoot, file: "git", args: ["clone", "--branch", V, ctx.sourceUrl, ctx.src] },
    }),
  );
  steps.push(
    step("S2", "local-write", `clone translations of ${previous}`, {
      requires: "S1",
      done: localZh,
      remote: ctx.zhUrl,
      branch: `${previous}_content`,
      targetCommit: branchNamed(zh.branches, `${previous}_content`).sha,
      commands: [`git clone --branch ${previous}_content ${ctx.zhUrl} ${ctx.zh}`],
      argv: { cwd: ctx.monoRoot, file: "git", args: ["clone", "--branch", `${previous}_content`, ctx.zhUrl, ctx.zh] },
    }),
  );
  steps.push(
    step("S3", "branch-create", `create ${ctx.contentBranch}`, {
      requires: "S2",
      done: !!localBranch,
      branch: ctx.contentBranch,
      targetCommit: headZh,
      commands: [`git switch -c ${ctx.contentBranch}  (in ${ctx.zh})`],
      argv: { cwd: zhAbs, file: "git", args: ["switch", "-c", ctx.contentBranch] },
    }),
  );
  const monoText = existsSync(monospecsFile) ? readFileSync(monospecsFile, "utf8") : "";
  const paths = entryPaths(monoText);
  steps.push(
    step("S4", "local-write", `register repos/${V} and repos/${V}_zh in monospecs`, {
      requires: "S3",
      done: paths.has(`repos/${V}`) && paths.has(`repos/${V}_zh`),
      inputs: { monospecs: fileSha(monospecsFile) },
      commands: [`append repos/${V} and repos/${V}_zh (optional: true, URLs from ${previous}) to ${MONOSPECS}`],
    }),
  );
  const profileFile = path.join(zhAbs, "translations", "profile.yaml");
  const releaseFile = path.join(zhAbs, "translations", "release.yaml");
  const profileNow = existsSync(profileFile) ? readFileSync(profileFile, "utf8") : "";
  const releaseNow = readRelease(releaseFile);
  steps.push(
    step("S5", "local-write", "write profile.yaml and release.yaml, commit them", {
      requires: "S4",
      done: /^repo:\s*"repos\/[^"]*"/m.test(profileNow) && profileNow.includes(`repos/${V}_zh`) && !!releaseNow && releaseNow.value?.version === V,
      inputs: { profile: fileSha(profileFile), release: fileSha(releaseFile) },
      commands: [
        `update version fields of ${ctx.zh}/translations/profile.yaml (repo, sources.description)`,
        `write ${ctx.zh}/translations/release.yaml if it is not already for ${V}`,
        `git add -- translations/profile.yaml translations/release.yaml  (in ${ctx.zh})`,
        `git commit -m "<messagePrefix>: bootstrap ${V} from ${previous}" -- translations/profile.yaml translations/release.yaml`,
      ],
    }),
  );
  steps.push(
    step("S6", "local-write", "zh:data:sync and status report", {
      requires: "S5",
      done: false,
      commands: [
        `pnpm run zh:data:sync --version ${V} --source-repo ${ctx.src} --zh-repo ${ctx.zh}`,
        `node ${normRel(path.relative(ctx.monoRoot, ctx.engine.tr))} scan --profile ${ctx.zh}/translations/profile.yaml --source-root ${ctx.zh}/data/source --json`,
      ],
    }),
  );
  steps.push(
    step("S7", "public-push", `push ${ctx.contentBranch} to ${ctx.zhUrl}`, {
      // S6 is a report and never marked done, so the push depends on the commit of S5 instead
      requires: "S5",
      done: !!remoteZhBranch && !!headZh && remoteZhBranch.sha === headZh,
      remote: ctx.zhUrl,
      branch: ctx.contentBranch,
      targetCommit: headZh,
      commands: [`git push origin ${ctx.contentBranch}  (in ${ctx.zh}; normal push, never --force)`],
      argv: { cwd: zhAbs, file: "git", args: ["push", "origin", ctx.contentBranch] },
    }),
  );
  plan.steps = steps;
  return plan;
}

function spawnBranchExists(ctx, cwd, name) {
  const r = ctx.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd });
  return r.status === 0;
}

/** The hashed description of one step. Any change to its remote, branch, target commit, command or inputs changes the hash. */
export function specOf(s) {
  return {
    stepId: s.id,
    kind: s.kind,
    remote: s.remote ?? null,
    branch: s.branch ?? null,
    targetCommit: s.targetCommit ?? null,
    command: s.commands,
    inputs: s.inputs ?? null,
  };
}

const stepHash = (s) => planHash(specOf(s));

/** Runs one confirmed step. Returns { ok, log, report? }. */
export function runStep(ctx, plan, s) {
  const log = [];
  const run = (argv) => {
    const r = ctx.exec(argv.file, argv.args, { cwd: argv.cwd });
    log.push({ cmd: `${argv.file} ${argv.args.join(" ")}`, exit: r.status ?? null });
    return r;
  };
  if (s.argv) {
    const r = run(s.argv);
    return r.status === 0 ? { ok: true, log } : { ok: false, log, error: tail(r.stderr) || r.error || `exit ${r.status}` };
  }
  if (s.id === "S4") return runMonospecs(ctx, plan, log);
  if (s.id === "S5") return runProfileAndRelease(ctx, plan, log);
  if (s.id === "S6") return runSyncAndScan(ctx, plan, log);
  return { ok: false, log, error: `no action for ${s.id}` };
}

function runMonospecs(ctx, plan, log) {
  const file = path.join(ctx.monoRoot, MONOSPECS);
  const previousUp = entryUrl(ctx.specs, `repos/${plan.previous}`) ?? ctx.sourceUrl;
  const previousZh = entryUrl(ctx.specs, `repos/${plan.previous}_zh`) ?? ctx.zhUrl;
  const result = appendEntries(readFileSync(file, "utf8"), { version: ctx.version, upstreamUrl: previousUp, zhUrl: previousZh });
  if (result.present) return { ok: true, log, report: { added: [], note: "already registered" } };
  writeFileSync(file, result.text);
  return { ok: true, log, report: { added: result.added } };
}

function runProfileAndRelease(ctx, plan, log) {
  const zhAbs = path.join(ctx.monoRoot, ctx.zh);
  const profileFile = path.join(zhAbs, "translations", "profile.yaml");
  const releaseFile = path.join(zhAbs, "translations", "release.yaml");
  const { text, changed } = updateProfileText(readFileSync(profileFile, "utf8"), { oldVersion: plan.previous, newVersion: ctx.version });
  if (changed.length) writeFileSync(profileFile, text);
  const existing = readRelease(releaseFile);
  if (!existing || existing.value?.version !== ctx.version) {
    const inherited = existing?.valid ? existing.value.upstreamPr.forkDocs : null;
    mkdirSync(path.dirname(releaseFile), { recursive: true });
    writeFileSync(
      releaseFile,
      renderRelease({
        version: ctx.version,
        previousVersion: plan.previous,
        upstreamUrl: entryUrl(ctx.specs, `repos/${ctx.version}`) ?? ctx.sourceUrl,
        forkDocs: inherited ?? { path: "repos/fork-docs", submodulePath: "translations/docs-zh" },
      }),
    );
    changed.push("release.yaml");
  }
  const check = validateRelease(parseYaml(readFileSync(releaseFile, "utf8")));
  if (!check.valid) return { ok: false, log, error: `generated release.yaml is invalid: ${[...check.missing, ...check.problems].join("; ")}` };
  if (changed.length === 0) return { ok: true, log, report: { changed, note: "nothing to change" } };
  const paths = ["translations/profile.yaml", "translations/release.yaml"];
  const prefix = (parseYaml(readFileSync(profileFile, "utf8")).commit ?? {}).messagePrefix ?? "docs(translation)";
  const message = `${prefix}: bootstrap ${ctx.version} from ${plan.previous}`;
  for (const args of [["add", "--", ...paths], ["commit", "-m", message, "--", ...paths]]) {
    const r = ctx.exec("git", args, { cwd: zhAbs });
    log.push({ cmd: `git ${args.join(" ")}`, exit: r.status ?? null });
    if (r.status !== 0) return { ok: false, log, error: tail(r.stderr) || `git ${args[0]} failed` };
  }
  return { ok: true, log, report: { changed, committed: paths, head: readHead(ctx.exec, zhAbs) } };
}

function runSyncAndScan(ctx, plan, log) {
  const sync = ctx.exec("pnpm", ["run", "zh:data:sync", "--version", ctx.version, "--source-repo", ctx.src, "--zh-repo", ctx.zh], { cwd: ctx.monoRoot });
  log.push({ cmd: `pnpm run zh:data:sync --version ${ctx.version}`, exit: sync.status ?? null });
  if (sync.status !== 0) return { ok: false, log, error: tail(sync.stderr) || sync.error || `zh:data:sync exit ${sync.status}` };
  const tr = normRel(path.relative(ctx.monoRoot, ctx.engine.tr));
  const profile = `${ctx.zh}/translations/profile.yaml`;
  const scan = ctx.exec("node", [tr, "scan", "--profile", profile, "--source-root", `${ctx.zh}/data/source`, "--json"], { cwd: ctx.monoRoot });
  log.push({ cmd: `node ${tr} scan --json`, exit: scan.status ?? null });
  if (scan.status !== 0) return { ok: false, log, error: tail(scan.stderr) || `scan exit ${scan.status}` };
  let summary;
  try {
    summary = JSON.parse(scan.stdout).summary ?? {};
  } catch {
    return { ok: false, log, error: "scan --json did not print JSON" };
  }
  return { ok: true, log, report: { fresh: summary.fresh ?? 0, stale: summary.stale ?? 0, new: summary.new ?? 0 } };
}

/**
 * apply: a dry run unless --execute is given. With --execute the step runs only if --confirm equals its current plan hash,
 * and only that step runs. Returns { ok, code, ... }.
 */
export function apply(ctx, { stepId, execute = false, confirm } = {}) {
  const plan = buildPlan(ctx);
  if (plan.stopped) return { ok: false, code: 1, reason: `plan stopped: ${plan.stopped}`, plan };
  const s = plan.steps.find((x) => x.id === stepId);
  if (!s) return { ok: false, code: 2, reason: `unknown step "${stepId}" (use S0 to S7)` };
  if (s.id === "S0") return { ok: true, code: 0, step: s.id, note: "read-only probe; nothing to apply", plan };
  if (s.done) return { ok: true, code: 0, step: s.id, note: "already done; nothing to run", plan };
  const prereq = plan.steps.find((x) => x.id === s.requires);
  if (prereq && !prereq.done) return { ok: false, code: 1, step: s.id, reason: `run ${prereq.id} first (${prereq.name} is not done)`, plan };
  const hash = stepHash(s);
  if (!execute) return { ok: true, code: 0, step: s.id, dryRun: true, hash, commands: s.commands, note: "dry run: nothing executed; confirm this hash to run the step", plan };
  const check = checkConfirm({ stepId: s.id, expected: hash, given: confirm });
  if (!check.ok) return { ok: false, code: check.code, step: s.id, hash, reason: check.reason, plan };
  const result = runStep(ctx, plan, s);
  return { ok: result.ok, code: result.ok ? 0 : 1, step: s.id, hash, executed: true, log: result.log, report: result.report, error: result.error, plan };
}

function formatPlan(plan) {
  const lines = [`## Version bootstrap plan: ${plan.version}`];
  if (plan.stopped) return [...lines, `stopped: ${plan.stopped}`].join("\n");
  lines.push(`previous ${plan.previous}  upstream ${plan.sourceUrl}  translations ${plan.zhUrl}`);
  for (const s of plan.steps) {
    const hash = s.kind === "read" ? "" : `  hash ${stepHash(s)}`;
    lines.push(`${s.id} [${s.kind}] ${s.done ? "done" : "todo"}  ${s.name}${hash}`);
    for (const c of s.commands) lines.push(`      ${c}`);
  }
  return lines.join("\n");
}

const USAGE = "usage: bootstrap.mjs plan | apply --step S<n> [--execute --confirm <hash>]  --version vX.Y [--previous vP] [--source-url URL] [--zh-url URL] [--mono-root DIR] [--engine DIR] [--json]";

export function main(argv, { out = console.log, err = console.error, cwd = process.cwd(), exec = spawnExec } = {}) {
  const [command, ...rest] = argv;
  if (!["plan", "apply"].includes(command)) {
    err(USAGE);
    return 2;
  }
  try {
    const opts = parseFlags(rest, { boolean: ["execute", "json"] });
    if (opts._.length) throw new ConfigError(`unexpected argument ${opts._[0]}\n${USAGE}`);
    const ctx = buildContext({
      cwd,
      monoRoot: opts["mono-root"],
      version: opts.version,
      previous: opts.previous,
      sourceUrl: opts["source-url"],
      zhUrl: opts["zh-url"],
      engine: opts.engine,
      exec,
    });
    if (command === "plan") {
      const plan = buildPlan(ctx);
      out(opts.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
      return plan.stopped ? 1 : 0;
    }
    if (!opts.step) throw new ConfigError(`apply needs --step S<n>\n${USAGE}`);
    const result = apply(ctx, { stepId: opts.step, execute: opts.execute === true, confirm: opts.confirm });
    if (opts.json) out(JSON.stringify(result, null, 2));
    else {
      const lines = [result.ok ? `step ${result.step ?? opts.step}: ${result.note ?? (result.executed ? "executed" : "ok")}` : `refused: ${result.reason ?? result.error}`];
      if (result.hash) lines.push(`plan hash ${result.hash}`);
      for (const c of result.commands ?? []) lines.push(`  would run: ${c}`);
      if (result.report) lines.push(`report: ${JSON.stringify(result.report)}`);
      out(lines.join("\n"));
    }
    return result.code;
  } catch (error) {
    if (error instanceof ConfigError) {
      err(`bootstrap: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
