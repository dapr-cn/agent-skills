import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { apply, buildContext } from "../../dapr-docs-upstream-pr/scripts/upstream-pr.mjs";
import { fakeExec, git, snapshotTree, tmpDir, write } from "../_fixtures/mono.mjs";
import { makeFixture, verdictFor } from "./fixture.mjs";

const refs = (dir) => git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout;
// Local branches only: `git fetch upstream` legitimately moves remote-tracking refs, which the tests do not count as a change.
const localHeads = (dir) => git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]).stdout;
const ZERO = "0000000000000000";

/** A fake exec that answers npm and gh; git runs for real (fakeExec passes git through). */
function tools({ npmBuild = 0, gh = { status: 0, stdout: "https://github.com/dapr/docs/pull/1\n" } } = {}) {
  return fakeExec((file, args) => {
    // only `npm run build` can fail here; `npm ci` always succeeds
    if (file === "npm") return args[0] === "run" ? { status: npmBuild, stderr: npmBuild ? "build broke" : "" } : { status: 0 };
    if (file === "gh") return gh;
    return { status: 0 };
  });
}

function ctxFor(fx, exec, extra = {}) {
  return buildContext({ monoRoot: fx.mono, version: "v1.18", out: path.join(fx.root, "pr"), exec, ...extra });
}

test("a dry run of stage A changes nothing anywhere", () => {
  const fx = makeFixture();
  const before = { zh: refs(fx.zhBare), fork: refs(fx.forkLocal), mono: snapshotTree(fx.mono) };
  const r = apply(ctxFor(fx, tools()), verdictFor(fx), { stage: "A" });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(refs(fx.zhBare), before.zh);
  assert.deepEqual(snapshotTree(fx.mono), before.mono);
});

test("a confirmation that does not match stage A is refused with exit 3 and nothing is pushed", () => {
  const fx = makeFixture();
  const before = refs(fx.zhBare);
  const r = apply(ctxFor(fx, tools()), verdictFor(fx), { stage: "A", execute: true, confirm: ZERO });
  assert.equal(r.code, 3);
  assert.equal(refs(fx.zhBare), before);
});

test("stage B is refused until the target commit is on the translation remote", () => {
  const fx = makeFixture();
  const r = apply(ctxFor(fx, tools()), verdictFor(fx), { stage: "B" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /run stage A first/);
  assert.equal(r.code, 1);
});

test("confirming only stage A pushes the translation branch and nothing from stage B runs", () => {
  const fx = makeFixture();
  const exec = tools();
  const v = verdictFor(fx);
  const planned = apply(ctxFor(fx, exec), v, { stage: "A" });
  const forkBefore = refs(fx.forkLocal);
  const r = apply(ctxFor(fx, exec), v, { stage: "A", execute: true, confirm: planned.hash });
  assert.equal(r.ok, true, JSON.stringify(r));
  const pushed = git(fx.zhBare, ["rev-parse", "refs/heads/v1.18_content"]).stdout.trim();
  assert.equal(pushed, v.headCommit);
  assert.equal(refs(fx.forkLocal), forkBefore, "stage B did not run");
  assert.equal(exec.calls.filter((c) => c.file === "npm").length, 0);
});

test("stage B with its confirmation builds the PR text, moves the submodule and commits on a work branch", () => {
  const fx = makeFixture();
  const exec = tools();
  const v = verdictFor(fx);
  apply(ctxFor(fx, exec), v, { stage: "A", execute: true, confirm: apply(ctxFor(fx, exec), v, { stage: "A" }).hash });
  const dry = apply(ctxFor(fx, exec), v, { stage: "B" });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  const r = apply(ctxFor(fx, exec), v, { stage: "B", execute: true, confirm: dry.hash });
  assert.equal(r.ok, true, JSON.stringify(r));
  // B1: local v1.18 fast-forwarded to the upstream U1
  const upstreamHead = git(fx.upBare, ["rev-parse", "refs/heads/v1.18"]).stdout.trim();
  assert.equal(git(fx.forkLocal, ["rev-parse", "refs/heads/v1.18"]).stdout.trim(), upstreamHead);
  // B2: work branch with the submodule at the pushed translation commit
  assert.equal(git(fx.forkLocal, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "translations-v1.18");
  assert.equal(git(path.join(fx.forkLocal, "translations", "docs-zh"), ["rev-parse", "HEAD"]).stdout.trim(), v.headCommit);
  const committed = git(fx.forkLocal, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim();
  assert.equal(committed, "translations/docs-zh");
  // B3: PR text written to --out, build run
  assert.equal(existsSync(path.join(fx.root, "pr", "title.txt")), true);
  assert.equal(existsSync(path.join(fx.root, "pr", "body.md")), true);
  assert.equal(exec.calls.filter((c) => c.file === "npm").map((c) => c.args.join(" ")).join(" | "), "ci | run build");
});

test("when the build fails, no PR text is written and nothing is pushed to the fork", () => {
  const fx = makeFixture();
  const v = verdictFor(fx);
  const okExec = tools();
  apply(ctxFor(fx, okExec), v, { stage: "A", execute: true, confirm: apply(ctxFor(fx, okExec), v, { stage: "A" }).hash });
  const exec = tools({ npmBuild: 1 });
  const dry = apply(ctxFor(fx, exec), v, { stage: "B" });
  const r = apply(ctxFor(fx, exec), v, { stage: "B", execute: true, confirm: dry.hash });
  assert.equal(r.ok, false);
  assert.match(r.error, /build failed/);
  assert.equal(existsSync(path.join(fx.root, "pr", "title.txt")), false);
  assert.equal(git(fx.forkBare, ["show-ref", "--verify", "--quiet", "refs/heads/translations-v1.18"]).status, 1);
});

test("a fork branch that has diverged from upstream stops stage B and nothing is merged or reset", () => {
  const fx = makeFixture();
  const v = verdictFor(fx);
  const exec = tools();
  apply(ctxFor(fx, exec), v, { stage: "A", execute: true, confirm: apply(ctxFor(fx, exec), v, { stage: "A" }).hash });
  // a local commit on the fork's v1.18 that upstream does not have
  git(fx.forkLocal, ["checkout", "-q", "v1.18"]);
  write(path.join(fx.forkLocal, "local-only.md"), "local\n");
  git(fx.forkLocal, ["add", "-A"]);
  git(fx.forkLocal, ["commit", "-q", "-m", "local only"]);
  const before = localHeads(fx.forkLocal);
  const dry = apply(ctxFor(fx, exec), v, { stage: "B" });
  const r = apply(ctxFor(fx, exec), v, { stage: "B", execute: true, confirm: dry.hash });
  assert.equal(r.ok, false);
  assert.match(r.error, /diverged/);
  assert.equal(localHeads(fx.forkLocal), before, "no local branch merged or reset");
});

test("a translation push that is not a fast-forward is rejected and never forced", () => {
  const fx = makeFixture();
  // someone else put a different commit on the remote's v1.18_content
  const other = tmpDir("dapr-other-");
  git(other, ["clone", "-q", "--branch", "main", fx.zhBare, "clone"]);
  const clone = path.join(other, "clone");
  git(clone, ["config", "user.name", "t"]);
  git(clone, ["config", "user.email", "t@example.com"]);
  git(clone, ["checkout", "-q", "-b", "v1.18_content"]);
  write(path.join(clone, "elsewhere.md"), "other\n");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-q", "-m", "someone else"]);
  git(clone, ["push", "-q", fx.zhBare, "v1.18_content"]);
  const remoteBefore = refs(fx.zhBare);
  const exec = tools();
  const v = verdictFor(fx);
  const planned = apply(ctxFor(fx, exec), v, { stage: "A" });
  const r = apply(ctxFor(fx, exec), v, { stage: "A", execute: true, confirm: planned.hash });
  assert.equal(r.ok, false);
  assert.equal(refs(fx.zhBare), remoteBefore, "the remote branch is untouched");
});

test("B4 and B5 each need their own confirmation, and B5 opens the PR against the upstream branch", () => {
  const fx = makeFixture();
  const exec = tools();
  const v = verdictFor(fx);
  apply(ctxFor(fx, exec), v, { stage: "A", execute: true, confirm: apply(ctxFor(fx, exec), v, { stage: "A" }).hash });
  const b = apply(ctxFor(fx, exec), v, { stage: "B" });
  apply(ctxFor(fx, exec), v, { stage: "B", execute: true, confirm: b.hash });
  // B4 without a confirmation does nothing
  const b4 = apply(ctxFor(fx, exec), v, { stepId: "B4" });
  assert.equal(b4.dryRun, true);
  assert.equal(git(fx.forkBare, ["show-ref", "--verify", "--quiet", "refs/heads/translations-v1.18"]).status, 1);
  // a stage B confirmation does not confirm B4
  const wrong = apply(ctxFor(fx, exec), v, { stepId: "B4", execute: true, confirm: b.hash });
  assert.equal(wrong.code, 3);
  // the B4 hash confirms B4 only
  const r4 = apply(ctxFor(fx, exec), v, { stepId: "B4", execute: true, confirm: b4.hash });
  assert.equal(r4.ok, true, JSON.stringify(r4));
  assert.equal(git(fx.forkBare, ["show-ref", "--verify", "--quiet", "refs/heads/translations-v1.18"]).status, 0);
  // B5
  const b5 = apply(ctxFor(fx, exec), v, { stepId: "B5" });
  const r5 = apply(ctxFor(fx, exec), v, { stepId: "B5", execute: true, confirm: b5.steps ? b5.steps[0].hash : b5.hash });
  assert.equal(r5.ok, true, JSON.stringify(r5));
  const gh = exec.calls.find((c) => c.file === "gh");
  assert.ok(gh);
  assert.equal(gh.args[gh.args.indexOf("--base") + 1], "v1.18");
  assert.equal(gh.args[gh.args.indexOf("--head") + 1].endsWith(":translations-v1.18"), true);
  // the fixture upstream is a local path, so --repo falls back to it; a github URL maps to owner/repo (see githubRepo test)
  assert.equal(gh.args[gh.args.indexOf("--repo") + 1], fx.upBare);
});

test("a refused gate verdict is refused for every apply", () => {
  const fx = makeFixture();
  const r = apply(ctxFor(fx, tools()), verdictFor(fx, { canOpenPr: false, verdict: "blocked" }), { stage: "A", execute: true, confirm: ZERO });
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.match(r.reason, /gate refused/);
});
