import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildContext, commitPlan } from "../../dapr-docs-translate-incremental/scripts/incremental.mjs";
import { git, makeMono, snapshotTree, write } from "../_fixtures/mono.mjs";

function setupWithChanges() {
  const fixture = makeMono({
    version: "v1.18",
    zhFiles: { "translations/keep.md": "keep\n", "translated_content/t.md": "t\n", "data/source/s.md": "s\n", "scripts/x.mjs": "x\n" },
  });
  const { zh, mono, engine } = fixture;
  // in scope: a new translation, an edited translated file
  write(path.join(zh, "translations", "new.md"), "new\n");
  writeFileSync(path.join(zh, "translated_content", "t.md"), "changed\n");
  // out of scope: a data/ edit, a scripts/ edit, and a site/ file the user staged by hand
  writeFileSync(path.join(zh, "data", "source", "s.md"), "changed data\n");
  writeFileSync(path.join(zh, "scripts", "x.mjs"), "changed script\n");
  write(path.join(zh, "site", "hand.md"), "staged by hand\n");
  git(zh, ["add", "site/hand.md"]);
  const ctx = buildContext({ monoRoot: mono, version: "v1.18", engine });
  return { ctx, zh };
}

test("a dry run changes nothing: files, index, refs and git status are the same before and after", () => {
  const { ctx, zh } = setupWithChanges();
  const before = snapshotTree(zh);
  const plan = commitPlan(ctx, { execute: false });
  const after = snapshotTree(zh);
  assert.deepEqual(after, before);
  assert.equal(plan.executed, false);
  assert.equal(plan.committed, false);
  assert.match(plan.note, /dry run/);
  assert.ok(plan.commands.some((c) => c.includes("git commit -m")), "the dry run shows the commit command");
});

test("only translations/ and translated_content/ paths are committed; data/, scripts/ and the staged site/ file are left alone", () => {
  const { ctx, zh } = setupWithChanges();
  const headBefore = git(zh, ["rev-parse", "HEAD"]).stdout.trim();
  const plan = commitPlan(ctx, { execute: true });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.committed, true);
  assert.deepEqual(plan.paths, ["translated_content/t.md", "translations/new.md"]);
  assert.deepEqual(plan.others.map((o) => o.path).sort(), ["data/source/s.md", "scripts/x.mjs", "site/hand.md"].sort());
  const files = git(zh, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n").sort();
  assert.deepEqual(files, ["translated_content/t.md", "translations/new.md"]);
  assert.notEqual(git(zh, ["rev-parse", "HEAD"]).stdout.trim(), headBefore);
  const status = git(zh, ["status", "--porcelain=v1"]).stdout;
  assert.match(status, /^A  site\/hand\.md$/m, "the hand-staged file stays staged");
  assert.match(status, /^ M data\/source\/s\.md$/m);
  assert.match(status, /^ M scripts\/x\.mjs$/m);
});

test("the commit message uses the profile's messagePrefix and the version", () => {
  const { ctx, zh } = setupWithChanges();
  commitPlan(ctx, { execute: true });
  assert.equal(git(zh, ["log", "-1", "--format=%s"]).stdout.trim(), "docs(translation): v1.18 incremental translation");
});

test("with no changes under the commit roots nothing is committed", () => {
  const { zh, mono, engine } = makeMono({ version: "v1.18", zhFiles: { "translations/a.md": "a\n" } });
  writeFileSync(path.join(zh, "data", ".gitkeep"), "");
  write(path.join(zh, "scripts", "only.mjs"), "x\n");
  const ctx = buildContext({ monoRoot: mono, version: "v1.18", engine });
  const headBefore = git(zh, ["rev-parse", "HEAD"]).stdout.trim();
  const plan = commitPlan(ctx, { execute: true });
  assert.equal(plan.paths.length, 0);
  assert.equal(plan.committed, false);
  assert.match(plan.note, /no changes/);
  assert.equal(git(zh, ["rev-parse", "HEAD"]).stdout.trim(), headBefore);
});
