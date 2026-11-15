import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildContext, buildPlan } from "../../dapr-docs-version-bootstrap/scripts/bootstrap.mjs";
import { fakeExec, snapshotTree } from "../_fixtures/mono.mjs";
import { advanceRemote, makeRemotes } from "./remotes.mjs";

const FORBIDDEN_IN_PLAN = ["adopt"];

function ctxFor(fx, version, extra = {}) {
  return buildContext({ monoRoot: fx.mono, version, engine: fx.engine, ...extra });
}

test("the plan lists S0 to S7 in order, each step after the one before it", () => {
  const fx = makeRemotes();
  const plan = buildPlan(ctxFor(fx, "v1.18"));
  assert.equal(plan.stopped, null);
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"],
  );
  assert.equal(plan.steps[1].requires, "S0");
  assert.equal(plan.steps[7].requires, "S5");
  for (const s of plan.steps.slice(1)) assert.ok(s.requires);
});

test("the previous version is detected from the translation branches, skipping the missing v1.16", () => {
  const fx = makeRemotes();
  const plan = buildPlan(ctxFor(fx, "v1.18"));
  assert.equal(plan.previous, "v1.17");
  const earlier = buildPlan(ctxFor(fx, "v1.16"));
  assert.equal(earlier.previous, "v1.15");
});

test("an explicit --previous must have a translation branch", () => {
  const fx = makeRemotes();
  const bad = buildPlan(ctxFor(fx, "v1.18", { previous: "v1.16" }));
  assert.match(bad.stopped, /--previous v1\.16 has no v1\.16_content/);
  const good = buildPlan(ctxFor(fx, "v1.18", { previous: "v1.15" }));
  assert.equal(good.previous, "v1.15");
});

test("a target whose upstream branch is missing stops the plan and lists no steps", () => {
  const fx = makeRemotes();
  const plan = buildPlan(ctxFor(fx, "v1.99"));
  assert.match(plan.stopped, /has no branch v1\.99/);
  assert.deepEqual(plan.steps, []);
});

test("the S4 title names the concrete version instead of the placeholder V", () => {
  const fx = makeRemotes();
  const plan = buildPlan(ctxFor(fx, "v1.18"));
  const s4 = plan.steps.find((s) => s.id === "S4");
  const text = JSON.stringify(plan);
  assert.equal(text.includes("repos/V "), false, "plan must not contain the literal placeholder \"repos/V \"");
  assert.equal(text.includes("repos/V_zh"), false, "plan must not contain the literal placeholder \"repos/V_zh\"");
  assert.match(s4.name, /repos\/v1\.18 /);
  assert.match(s4.name, /repos\/v1\.18_zh/);
});

test("the plan never contains adopt", () => {
  const fx = makeRemotes();
  const text = JSON.stringify(buildPlan(ctxFor(fx, "v1.18")));
  for (const bad of FORBIDDEN_IN_PLAN) assert.equal(text.includes(bad), false, `plan must not contain "${bad}"`);
});

test("on a fresh checkout only S0 is done; done flags reflect what exists", () => {
  const fx = makeRemotes();
  const plan = buildPlan(ctxFor(fx, "v1.18"));
  assert.deepEqual(
    plan.steps.map((s) => s.done),
    [true, false, false, false, false, false, false, false],
  );
});

test("the plan's dry run does not touch the mono root", () => {
  const fx = makeRemotes();
  const before = snapshotTree(fx.mono);
  buildPlan(ctxFor(fx, "v1.18", { exec: fakeExec() }));
  assert.deepEqual(snapshotTree(fx.mono), before);
  assert.equal(existsSync(path.join(fx.mono, "repos", "v1.18")), false);
});

test("a plan whose translation remote already has the target branch stops unless a local clone exists", () => {
  const fx = makeRemotes({ contentVersions: ["v1.15", "v1.17", "v1.18"] });
  const plan = buildPlan(ctxFor(fx, "v1.18"));
  assert.match(plan.stopped, /already has v1\.18_content/);
});

test("the step hashes change when the target commit of the upstream branch changes", () => {
  const fx = makeRemotes();
  const before = buildPlan(ctxFor(fx, "v1.18")).steps[1];
  advanceRemote(fx.up.work, fx.up.bare, "v1.18");
  const after = buildPlan(ctxFor(fx, "v1.18")).steps[1];
  assert.notEqual(before.targetCommit, after.targetCommit);
});
