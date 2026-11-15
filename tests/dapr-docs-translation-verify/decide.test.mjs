import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../../dapr-docs-translation-verify/scripts/gate.mjs";

const ok = (name) => ({ name, exit: 0 });
const scopeClean = { inScope: [{ path: "translations/a.md" }], sync: [], outOfScope: [] };
const three = (overrides = {}) => [
  overrides["status-verify"] ?? ok("status-verify"),
  overrides["zh-data-audit"] ?? ok("zh-data-audit"),
  overrides["docs-verify"] ?? ok("docs-verify"),
];

test("all three checks pass and the scope is clean: canOpenPr is true", () => {
  const r = decide({ checks: three(), scope: scopeClean });
  assert.equal(r.canOpenPr, true);
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(
    r.checks.map((c) => c.verdict),
    ["pass", "pass", "pass"],
  );
});

test("a single check that exits non-zero fails the gate and the reason names the check and the exit code", () => {
  const r = decide({ checks: three({ "status-verify": { name: "status-verify", exit: 1 } }), scope: scopeClean });
  assert.equal(r.canOpenPr, false);
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.includes("status-verify: exit 1"), JSON.stringify(r.reasons));
  assert.equal(r.checks.length, 3, "the other checks are still recorded");
});

test("a command that did not run (no exit code) counts as a failure", () => {
  const r = decide({ checks: three({ "docs-verify": { name: "docs-verify", exit: null, error: "spawn pnpm ENOENT" } }), scope: scopeClean });
  assert.equal(r.canOpenPr, false);
  assert.equal(r.verdict, "fail");
  assert.match(r.reasons.join(" "), /docs-verify: did not run: spawn pnpm ENOENT/);
});

test("a path outside writeScope fails the gate", () => {
  const scope = { inScope: [], sync: [], outOfScope: [{ path: "scripts/x.mjs" }] };
  const r = decide({ checks: three(), scope });
  assert.equal(r.canOpenPr, false);
  assert.equal(r.verdict, "fail");
  assert.match(r.reasons.join(" "), /scripts\/x\.mjs/);
});

test("a sync output path is blocked, not failed, and the reason says it needs a manual commit", () => {
  const scope = { inScope: [], sync: [{ path: "data/source/a.md" }], outOfScope: [] };
  const r = decide({ checks: three(), scope });
  assert.equal(r.canOpenPr, false);
  assert.equal(r.verdict, "blocked");
  assert.match(r.reasons.join(" "), /同步产物需单独人工提交/);
});

test("a check that changed the repository makes the verdict blocked and lists the new paths", () => {
  const r = decide({ checks: three(), scope: scopeClean, snapshotChanged: true, newPaths: ["translations/new-by-audit.md"] });
  assert.equal(r.canOpenPr, false);
  assert.equal(r.verdict, "blocked");
  assert.match(r.reasons.join(" "), /translations\/new-by-audit\.md/);
});

test("a failure and a block together: the verdict is fail, and both reasons are recorded", () => {
  const scope = { inScope: [], sync: [{ path: "data/a.md" }], outOfScope: [] };
  const r = decide({ checks: three({ "status-verify": { name: "status-verify", exit: 1 } }), scope });
  assert.equal(r.verdict, "fail");
  assert.equal(r.reasons.length, 2);
});
