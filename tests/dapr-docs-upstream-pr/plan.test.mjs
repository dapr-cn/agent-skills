import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { buildContext, buildPlan, githubRepo } from "../../dapr-docs-upstream-pr/scripts/upstream-pr.mjs";
import { snapshotTree, git } from "../_fixtures/mono.mjs";
import { makeFixture, verdictFor } from "./fixture.mjs";

test("the plan has stage A (A1) and stage B (B1 to B3), with B4 and B5 as separate public steps, each with a hash", () => {
  const fx = makeFixture();
  const ctx = buildContext({ monoRoot: fx.mono, version: "v1.18", out: path.join(fx.root, "pr") });
  const plan = buildPlan(ctx, verdictFor(fx));
  assert.equal(plan.gate.ok, true);
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ["A1", "B1", "B2", "B3", "B4", "B5"],
  );
  assert.deepEqual(plan.stages.A.steps, ["A1"]);
  assert.deepEqual(plan.stages.B.steps, ["B1", "B2", "B3"]);
  assert.match(plan.stages.A.hash, /^[0-9a-f]{16}$/);
  assert.notEqual(plan.stages.A.hash, plan.stages.B.hash);
});

test("every public step has a normal push or PR, and no step uses --force", () => {
  const fx = makeFixture();
  const plan = buildPlan(buildContext({ monoRoot: fx.mono, version: "v1.18", out: path.join(fx.root, "pr") }), verdictFor(fx));
  const argvs = plan.steps.flatMap((s) => s.argv?.args ?? []);
  assert.equal(argvs.includes("--force") || argvs.includes("-f") || argvs.includes("--force-with-lease"), false, "no force push in any command");
  const a1 = plan.steps.find((s) => s.id === "A1");
  assert.equal(a1.argv.args[0], "push");
  assert.equal(a1.argv.args.includes("--force"), false);
});

test("the upstream and the translation remote come from the release and monospecs, not hard-coded", () => {
  const fx = makeFixture();
  const plan = buildPlan(buildContext({ monoRoot: fx.mono, version: "v1.18", out: path.join(fx.root, "pr") }), verdictFor(fx));
  assert.equal(plan.target.upstreamUrl, fx.upBare);
  assert.equal(plan.target.zhUrl, fx.zhBare);
  assert.equal(plan.steps.find((s) => s.id === "B1").remote, fx.upBare);
  assert.equal(plan.steps.find((s) => s.id === "A1").remote, fx.zhBare);
});

test("a refused verdict yields no steps and no confirmation value", () => {
  const fx = makeFixture();
  const ctx = buildContext({ monoRoot: fx.mono, version: "v1.18", out: path.join(fx.root, "pr") });
  const plan = buildPlan(ctx, verdictFor(fx, { canOpenPr: false, verdict: "fail" }));
  assert.equal(plan.gate.ok, false);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.stages, {});
});

test("a plan with a stale verdict is refused", () => {
  const fx = makeFixture();
  const plan = buildPlan(buildContext({ monoRoot: fx.mono, version: "v1.18" }), verdictFor(fx, { generatedAt: "2020-01-01T00:00:00.000Z" }));
  assert.equal(plan.gate.ok, false);
  assert.match(plan.gate.reasons.join(" "), /older than 30 minutes/);
});

test("building the plan changes nothing in the translation repo, the fork or the mono root", () => {
  const fx = makeFixture();
  const refs = (dir) => git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout;
  const before = { mono: snapshotTree(fx.mono), zh: refs(fx.zhBare), up: refs(fx.upBare), fork: refs(fx.forkBare) };
  buildPlan(buildContext({ monoRoot: fx.mono, version: "v1.18", out: path.join(fx.root, "pr") }), verdictFor(fx));
  assert.deepEqual(snapshotTree(fx.mono), before.mono);
  assert.equal(refs(fx.zhBare), before.zh);
  assert.equal(refs(fx.upBare), before.up);
  assert.equal(refs(fx.forkBare), before.fork);
});

test("the release.yaml of the translation repo must be valid, and --version must match it", () => {
  const fx = makeFixture();
  assert.throws(() => buildContext({ monoRoot: fx.mono, version: "v1.17" }), /does not match|no translations|invalid/);
});

test("a github URL maps to owner/repo for the PR target, and anything else is left alone", () => {
  assert.equal(githubRepo("https://github.com/dapr/docs.git"), "dapr/docs");
  assert.equal(githubRepo("git@github.com:dapr-cn/fork-docs.git"), "dapr-cn/fork-docs");
  assert.equal(githubRepo("/tmp/some/local.git"), null);
});
