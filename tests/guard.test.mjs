import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, checkConfirm, planHash } from "../dapr-docs-version-bootstrap/scripts/lib/guard.mjs";

const stepA = {
  stepId: "A1",
  kind: "public-push",
  remote: "https://github.com/dapr/docs-zh.git",
  branch: "v1.18_content",
  targetCommit: "abc123",
  command: ["git", "push", "origin", "v1.18_content"],
};

test("the hash is stable for the same step and independent of key order", () => {
  const reordered = { command: stepA.command, targetCommit: stepA.targetCommit, branch: stepA.branch, remote: stepA.remote, kind: stepA.kind, stepId: stepA.stepId };
  assert.equal(planHash(stepA), planHash(reordered));
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("a confirmation matches only when it equals the hash of the current plan", () => {
  const expected = planHash(stepA);
  assert.deepEqual(checkConfirm({ stepId: "A1", expected, given: expected }).ok, true);
  const refused = checkConfirm({ stepId: "A1", expected, given: "0000000000000000" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 3);
});

test("after the target commit changed, an earlier confirmation is refused", () => {
  const confirmed = planHash(stepA);
  const later = planHash({ ...stepA, targetCommit: "def456" });
  assert.notEqual(confirmed, later);
  const r = checkConfirm({ stepId: "A1", expected: later, given: confirmed });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
});

test("a confirmation for stage A does not run stage B: the step id is part of the hash", () => {
  const stageA = planHash(stepA);
  const stageB = planHash({ ...stepA, stepId: "B4" });
  const r = checkConfirm({ stepId: "B4", expected: stageB, given: stageA });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
});

test("without a confirmation the step does not run, even when an old value sits in the environment", () => {
  const previous = process.env.DAPR_TEST_CONFIRM;
  process.env.DAPR_TEST_CONFIRM = planHash(stepA);
  try {
    const r = checkConfirm({ stepId: "A1", expected: planHash(stepA) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 2);
  } finally {
    if (previous === undefined) delete process.env.DAPR_TEST_CONFIRM;
    else process.env.DAPR_TEST_CONFIRM = previous;
  }
});
