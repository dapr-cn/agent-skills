import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext, runPhase } from "../../dapr-docs-translate-incremental/scripts/incremental.mjs";
import { fakeExec, makeMono } from "../_fixtures/mono.mjs";

const scanJson = (pending = []) => JSON.stringify({ schema: 1, summary: { fresh: 3, stale: 0 }, pending, picked: [] });
const pendingDoc = (doc) => ({ doc, class: "new", bytes: 100, tier: 1, incremental: false });

function setup() {
  const { mono, engine } = makeMono({ version: "v1.18" });
  return { mono, ctx: buildContext({ monoRoot: mono, version: "v1.18", engine }) };
}

// Routes each planned command to a canned answer by its arguments.
const answer = ({ sync = 0, scan = scanJson([]), status = 0 } = {}) => (file, args) => {
  if (args.includes("zh:data:sync")) return { status: sync, stderr: sync ? "sync broke" : "" };
  if (args.includes("scan")) return { status: 0, stdout: scan };
  if (args.includes("status")) return { status };
  return { status: 0 };
};

test("the pre phase runs sync, sync source documents and scan, in that order, from the mono root", () => {
  const { ctx, mono } = setup();
  const exec = fakeExec(answer({ scan: scanJson([pendingDoc("docs/a.md")]) }));
  const r = runPhase(ctx, "pre", exec);
  assert.equal(r.ok, true);
  assert.equal(exec.calls.length, 3);
  assert.deepEqual(exec.calls[0].args, ["run", "sync:repos"]);
  assert.ok(exec.calls[1].args.includes("zh:data:sync"));
  assert.ok(exec.calls[2].args.includes("scan"));
  assert.ok(exec.calls.every((c) => c.cwd === mono));
  assert.equal(r.nothingToDo, false);
  assert.equal(r.pendingCount, 1);
});

test("when zh:data:sync fails, scan and the translation step are not run and the failing step is named", () => {
  const { ctx } = setup();
  const exec = fakeExec(answer({ sync: 2 }));
  const r = runPhase(ctx, "pre", exec);
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 2);
  assert.equal(r.exitCode, 2);
  assert.equal(exec.calls.length, 2, "scan must not run after a failed sync");
  assert.equal(exec.calls.some((c) => c.args.includes("scan")), false);
});

test("a scan with no pending documents is reported as 无待办, and the post phase still runs status", () => {
  const { ctx } = setup();
  const pre = runPhase(ctx, "pre", fakeExec(answer({ scan: scanJson([]) })));
  assert.equal(pre.ok, true);
  assert.equal(pre.nothingToDo, true);
  assert.equal(pre.pendingCount, 0);
  const exec = fakeExec(answer());
  const post = runPhase(ctx, "post", exec);
  assert.equal(post.ok, true);
  assert.equal(exec.calls.length, 1);
  assert.ok(exec.calls[0].args.includes("status"));
});

test("a failing status step is reported with its number", () => {
  const { ctx } = setup();
  const r = runPhase(ctx, "post", fakeExec(answer({ status: 1 })));
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 5);
});

test("a scan that prints no JSON is a failed step 3", () => {
  const { ctx } = setup();
  const r = runPhase(ctx, "pre", fakeExec(answer({ scan: "not json" })));
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 3);
});

test("a missing executable (no exit code) counts as a failure, not a success", () => {
  const { ctx } = setup();
  const exec = fakeExec((file) => (file === "pnpm" ? { status: null, error: "spawn pnpm ENOENT" } : { status: 0 }));
  const r = runPhase(ctx, "pre", exec);
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 1);
  assert.equal(r.exitCode, null);
  assert.equal(exec.calls.length, 1);
});
