import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { classify, parsePorcelainZ, spawnExec, statusDigest, statusEntries } from "../dapr-docs-translate-incremental/scripts/lib/git.mjs";
import { git, makeMono, write } from "./_fixtures/mono.mjs";

test("porcelain -z parsing covers staged, unstaged, untracked and renamed entries", () => {
  // `R  new` is followed by its original path as a separate NUL-terminated field
  const raw = ["R  translations/new.md", "translations/old.md", " M translated_content/a.md", "A  data/b.md", "?? translations/c.md", ""].join("\0");
  const entries = parsePorcelainZ(raw);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], {
    x: "R",
    y: " ",
    path: "translations/new.md",
    from: "translations/old.md",
    staged: true,
    unstaged: false,
    untracked: false,
  });
  assert.equal(entries[1].unstaged, true);
  assert.equal(entries[1].staged, false);
  assert.equal(entries[2].staged, true);
  assert.equal(entries[3].untracked, true);
});

test("classify sorts paths into writeScope, sync output and out of scope, and counts both sides of a rename", () => {
  const entries = parsePorcelainZ(
    ["R  translations/new.md", "scripts/old.mjs", " M data/source/x.md", "?? site/y.md", " M translated_content/a.md", ""].join("\0"),
  );
  const c = classify(entries, { writeScope: ["translations/", "translated_content/"], syncOutputPaths: ["data/"] });
  assert.deepEqual(
    c.inScope.map((p) => p.path),
    ["translations/new.md", "translated_content/a.md"],
  );
  assert.deepEqual(
    c.sync.map((p) => p.path),
    ["data/source/x.md"],
  );
  assert.deepEqual(c.outOfScope.map((p) => p.path).sort(), ["scripts/old.mjs", "site/y.md"].sort());
});

test("a path that only shares a prefix with a scope is not in that scope", () => {
  const entries = parsePorcelainZ(["?? translations2/x.md", ""].join("\0"));
  const c = classify(entries, { writeScope: ["translations/"], syncOutputPaths: [] });
  assert.equal(c.outOfScope.length, 1);
});

test("statusDigest does not depend on entry order and changes when the status changes", () => {
  const a = parsePorcelainZ([" M a.md", "?? b.md", ""].join("\0"));
  const b = [...a].reverse();
  assert.equal(statusDigest(a), statusDigest(b));
  assert.notEqual(statusDigest(a), statusDigest(parsePorcelainZ([" M a.md", "?? c.md", ""].join("\0"))));
});

test("on a real repository, staging, renaming and untracked files are classified and nothing is changed", () => {
  const { zh } = makeMono({ version: "v1.18", zhFiles: { "translations/keep.md": "keep\n", "translated_content/t.md": "t\n" } });
  // a rename (staged), an unstaged edit and an untracked file
  git(zh, ["mv", "translations/keep.md", "translations/renamed.md"]);
  writeFileSync(path.join(zh, "translated_content", "t.md"), "changed\n");
  write(path.join(zh, "data", "extra.md"), "new\n");
  const before = git(zh, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const entries = statusEntries(spawnExec, zh);
  const after = git(zh, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  assert.equal(before, after, "statusEntries must not change the repository");
  const c = classify(entries, { writeScope: ["translations/", "translated_content/"], syncOutputPaths: ["data/"] });
  const inScopePaths = c.inScope.map((p) => p.path).sort();
  assert.deepEqual(inScopePaths, ["translated_content/t.md", "translations/keep.md", "translations/renamed.md"].sort());
  assert.deepEqual(
    c.sync.map((p) => p.path),
    ["data/extra.md"],
  );
  assert.equal(c.outOfScope.length, 0);
  const renamed = entries.find((e) => e.path === "translations/renamed.md");
  assert.equal(renamed.staged, true);
  assert.equal(renamed.from, "translations/keep.md");
  const untracked = entries.find((e) => e.path === "data/extra.md");
  assert.equal(untracked.untracked, true);
});
