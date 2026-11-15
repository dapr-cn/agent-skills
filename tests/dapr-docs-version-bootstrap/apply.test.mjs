import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { apply, buildContext, updateProfileText } from "../../dapr-docs-version-bootstrap/scripts/bootstrap.mjs";
import { git, fakeExec, snapshotTree } from "../_fixtures/mono.mjs";
import { parseYaml } from "../../dapr-docs-version-bootstrap/scripts/lib/yaml.mjs";
import { validateRelease } from "../../dapr-docs-version-bootstrap/scripts/lib/config.mjs";
import { advanceRemote, makeRemotes } from "./remotes.mjs";

const ZERO = "0000000000000000";
const scanJson = (summary) => JSON.stringify({ schema: 1, summary, pending: [] });

function setup(extraHandler) {
  const fx = makeRemotes();
  const exec = fakeExec(extraHandler ?? (() => ({ status: 0 })));
  const ctx = buildContext({ monoRoot: fx.mono, version: "v1.18", engine: fx.engine, exec });
  return { fx, ctx, exec };
}

const hashOf = (ctx, stepId) => apply(ctx, { stepId, execute: false }).hash;

test("a dry run changes nothing: files, and the refs of the local and remote repositories", () => {
  const { fx, ctx } = setup();
  const refs = (dir) => git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout;
  const before = { mono: snapshotTree(fx.mono), up: refs(fx.up.bare), zh: refs(fx.zh.bare) };
  const r = apply(ctx, { stepId: "S1", execute: false });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.match(r.hash, /^[0-9a-f]{16}$/);
  assert.deepEqual(snapshotTree(fx.mono), before.mono);
  assert.equal(refs(fx.up.bare), before.up);
  assert.equal(refs(fx.zh.bare), before.zh);
});

test("confirming only the clone step runs only that step", () => {
  const { fx, ctx } = setup();
  const monospecsBefore = readFileSync(path.join(fx.mono, ".hagicode", "monospecs.yaml"), "utf8");
  const r = apply(ctx, { stepId: "S1", execute: true, confirm: hashOf(ctx, "S1") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(existsSync(path.join(fx.mono, "repos", "v1.18", ".git")), true);
  assert.equal(existsSync(path.join(fx.mono, "repos", "v1.18_zh")), false, "S2 must not run");
  assert.equal(readFileSync(path.join(fx.mono, ".hagicode", "monospecs.yaml"), "utf8"), monospecsBefore, "S4 must not run");
});

test("a confirmation that does not match the plan is refused with exit 3 and nothing runs", () => {
  const { fx, ctx } = setup();
  const r = apply(ctx, { stepId: "S1", execute: true, confirm: ZERO });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.equal(existsSync(path.join(fx.mono, "repos", "v1.18")), false);
});

test("an earlier confirmation is refused after the upstream branch moved", () => {
  const { fx, ctx } = setup();
  const stale = hashOf(ctx, "S1");
  advanceRemote(fx.up.work, fx.up.bare, "v1.18");
  const r = apply(ctx, { stepId: "S1", execute: true, confirm: stale });
  assert.equal(r.code, 3);
  assert.equal(existsSync(path.join(fx.mono, "repos", "v1.18")), false);
});

test("a step cannot run before the step it requires is done", () => {
  const { ctx } = setup();
  const r = apply(ctx, { stepId: "S2", execute: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /run S1 first/);
});

test("S1 to S5 land the new version: branch, monospecs entries, profile, release.yaml and one commit", () => {
  const { fx, ctx } = setup();
  const monospecsOriginal = readFileSync(path.join(fx.mono, ".hagicode", "monospecs.yaml"), "utf8");
  for (const id of ["S1", "S2", "S3", "S4", "S5"]) {
    const r = apply(ctx, { stepId: id, execute: true, confirm: hashOf(ctx, id) });
    assert.equal(r.ok, true, `${id}: ${JSON.stringify(r)}`);
  }
  const zh = path.join(fx.mono, "repos", "v1.18_zh");
  assert.equal(git(zh, ["branch", "--show-current"]).stdout.trim(), "v1.18_content");

  const monospecs = readFileSync(path.join(fx.mono, ".hagicode", "monospecs.yaml"), "utf8");
  assert.ok(monospecs.startsWith(monospecsOriginal), "existing monospecs text is kept byte for byte");
  const reg = parseYaml(monospecs).repositories;
  assert.equal(reg.find((r) => r.path === "repos/v1.18_zh").branch, "v1.18_content");
  assert.equal(reg.find((r) => r.path === "repos/v1.18").optional, true);

  const profileOld = git(zh, ["show", "v1.17_content:translations/profile.yaml"]).stdout;
  const profileNew = readFileSync(path.join(zh, "translations", "profile.yaml"), "utf8");
  assert.match(profileNew, /^repo: "repos\/v1\.18_zh"/m);
  assert.match(profileNew, /description: ".*v1\.18 documentation mirror/);
  const changedLines = profileOld.split("\n").filter((l, i) => profileNew.split("\n")[i] !== l);
  assert.equal(changedLines.length, 2, "only repo and sources.description change");

  const release = parseYaml(readFileSync(path.join(zh, "translations", "release.yaml"), "utf8"));
  assert.equal(release.version, "v1.18");
  assert.equal(release.previousVersion, "v1.17");
  assert.equal(validateRelease(release).valid, true);

  assert.deepEqual(git(zh, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n").sort(), [
    "translations/profile.yaml",
    "translations/release.yaml",
  ]);
});

test("S3 alone creates the branch and touches nothing else", () => {
  const { fx, ctx } = setup();
  apply(ctx, { stepId: "S1", execute: true, confirm: hashOf(ctx, "S1") });
  apply(ctx, { stepId: "S2", execute: true, confirm: hashOf(ctx, "S2") });
  const monospecsBefore = readFileSync(path.join(fx.mono, ".hagicode", "monospecs.yaml"), "utf8");
  const zh = path.join(fx.mono, "repos", "v1.18_zh");
  const profileBefore = readFileSync(path.join(zh, "translations", "profile.yaml"), "utf8");
  const r = apply(ctx, { stepId: "S3", execute: true, confirm: hashOf(ctx, "S3") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(git(zh, ["show-ref", "--verify", "--quiet", "refs/heads/v1.18_content"]).status, 0);
  assert.equal(readFileSync(path.join(fx.mono, ".hagicode", "monospecs.yaml"), "utf8"), monospecsBefore);
  assert.equal(readFileSync(path.join(zh, "translations", "profile.yaml"), "utf8"), profileBefore);
});

test("an interrupted run resumes: a completed step is reported done and does not run again", () => {
  const { ctx, exec } = setup();
  apply(ctx, { stepId: "S1", execute: true, confirm: hashOf(ctx, "S1") });
  const mutating = (calls) => calls.filter((c) => c.file === "git" && ["clone", "switch", "add", "commit", "push"].includes(c.args[0]));
  const before = mutating(exec.calls).length;
  const r = apply(ctx, { stepId: "S1", execute: true, confirm: "anything" });
  assert.equal(r.ok, true);
  assert.match(r.note, /already done/);
  assert.equal(mutating(exec.calls).length, before, "no clone, switch, commit or push runs for a done step");
});

test("S6 reports fresh, stale and new counts from scan --json and stops when zh:data:sync fails", () => {
  const counts = { fresh: 5, stale: 2, new: 7 };
  const { ctx } = setup((file, args) => {
    if (file === "pnpm") return { status: 0 };
    if (args.includes("scan")) return { status: 0, stdout: scanJson({ ...counts, edited: 0 }) };
    return { status: 0 };
  });
  for (const id of ["S1", "S2", "S3", "S4", "S5"]) apply(ctx, { stepId: id, execute: true, confirm: hashOf(ctx, id) });
  const r = apply(ctx, { stepId: "S6", execute: true, confirm: hashOf(ctx, "S6") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.report, counts);

  const failing = setup((file) => (file === "pnpm" ? { status: 1, stderr: "sync broke" } : { status: 0 }));
  for (const id of ["S1", "S2", "S3", "S4", "S5"]) apply(failing.ctx, { stepId: id, execute: true, confirm: hashOf(failing.ctx, id) });
  const failed = apply(failing.ctx, { stepId: "S6", execute: true, confirm: hashOf(failing.ctx, "S6") });
  assert.equal(failed.ok, false);
  assert.equal(failing.exec.calls.filter((c) => c.args.includes("scan")).length, 0, "scan must not run after a failed sync");
});

test("S7 pushes the branch normally, never with --force, and only after its own confirmation", () => {
  const { fx, ctx, exec } = setup((file, args) => {
    if (file === "pnpm") return { status: 0 };
    if (args.includes("scan")) return { status: 0, stdout: scanJson({ fresh: 1, stale: 0, new: 0 }) };
    return { status: 0 };
  });
  for (const id of ["S1", "S2", "S3", "S4", "S5", "S6"]) apply(ctx, { stepId: id, execute: true, confirm: hashOf(ctx, id) });
  const dry = apply(ctx, { stepId: "S7", execute: false });
  assert.equal(dry.dryRun, true);
  assert.equal(git(fx.zh.bare, ["show-ref", "--verify", "--quiet", "refs/heads/v1.18_content"]).status, 1, "a dry run pushes nothing");
  const r = apply(ctx, { stepId: "S7", execute: true, confirm: dry.hash });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(git(fx.zh.bare, ["show-ref", "--verify", "--quiet", "refs/heads/v1.18_content"]).status, 0);
  const pushes = exec.calls.filter((c) => c.file === "git" && c.args[0] === "push");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].args.some((a) => a.includes("force") || a === "-f"), false);
});

test("updateProfileText changes only the repo line and the sources description", () => {
  const text = 'schema: 1\nrepo: "repos/v1.17_zh"   # informational\nsources:\n  description: "English Dapr v1.17 documentation mirror under repos/v1.17."\n  glob:\n    root: "data/source"\n';
  const r = updateProfileText(text, { oldVersion: "v1.17", newVersion: "v1.18" });
  assert.deepEqual(r.changed, ["repo", "sources.description"]);
  assert.equal(r.text, text.replaceAll("v1.17", "v1.18"));
  assert.equal(updateProfileText(r.text, { oldVersion: "v1.17", newVersion: "v1.18" }).changed.length, 0, "idempotent");
});
