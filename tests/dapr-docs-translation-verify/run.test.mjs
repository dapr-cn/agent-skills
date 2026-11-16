import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildContext, FAIL_ON, main, runGate } from "../../dapr-docs-translation-verify/scripts/gate.mjs";
import { fakeExec, git, makeMono, snapshotTree, tmpDir, write } from "../_fixtures/mono.mjs";

const RELEASE_V118 = `schema: 1
version: v1.18
syncOutputPaths:
  - data/
upstreamPr:
  forkDocs:
    path: repos/fork-docs
    submodulePath: translations/docs-zh
    upstreamUrl: https://github.com/dapr/docs.git
    upstreamBranch: v1.18
`;

function setup(extra = {}) {
  const fixture = makeMono({ version: "v1.18", release: RELEASE_V118, zhFiles: { "translations/a.md": "a\n" }, ...extra });
  const ctx = buildContext({ monoRoot: fixture.mono, version: "v1.18", engine: fixture.engine });
  return { ...fixture, ctx };
}

// The gate's own git calls (status, rev-parse) go through the same exec; the checks are the calls that are not git.
const checkCalls = (exec) => exec.calls.filter((c) => c.file !== "git");

// Answers each check by the argument that identifies it.
const byName = (overrides = {}) => (file, args) => {
  if (args.includes("--verify")) return overrides["status-verify"] ?? { status: 0 };
  if (args.includes("audit")) return overrides["zh-data-audit"] ?? { status: 0 };
  if (args.includes("docs:verify")) return overrides["docs-verify"] ?? { status: 0 };
  return { status: 0 };
};

test("when all three checks pass the verdict carries the freshness fields", () => {
  const { ctx, zh } = setup();
  const v = runGate(ctx, { exec: fakeExec(byName()), now: () => "2026-11-15T00:00:00.000Z" });
  assert.equal(v.canOpenPr, true);
  assert.equal(v.verdict, "pass");
  assert.equal(v.generatedAt, "2026-11-15T00:00:00.000Z");
  assert.equal(v.headCommit, git(zh, ["rev-parse", "HEAD"]).stdout.trim());
  assert.match(v.statusDigest, /^[0-9a-f]{64}$/);
  assert.equal(v.version, "v1.18");
  assert.equal(v.repo, "repos/v1.18_zh");
});

test("a failing status check is recorded, and the other two checks still run", () => {
  const { ctx } = setup();
  const exec = fakeExec(byName({ "status-verify": { status: 1 } }));
  const v = runGate(ctx, { exec });
  assert.equal(checkCalls(exec).length, 3, "all three checks ran");
  assert.equal(v.canOpenPr, false);
  assert.equal(v.verdict, "fail");
  assert.ok(v.reasons.some((r) => r.startsWith("status-verify: exit 1")));
  assert.equal(
    v.checks.find((c) => c.name === "docs-verify").verdict,
    "pass",
  );
});

test("a check that cannot start is a failure", () => {
  const { ctx } = setup();
  const exec = fakeExec((file, args) => (args.includes("docs:verify") ? { status: null, error: "spawn pnpm ENOENT" } : byName()(file, args)));
  const v = runGate(ctx, { exec });
  assert.equal(v.canOpenPr, false);
  assert.equal(v.checks.find((c) => c.name === "docs-verify").exit, null);
});

test("a check that writes a file makes the verdict blocked and names the new file", () => {
  const { ctx, zh } = setup();
  const exec = fakeExec((file, args) => {
    if (args.includes("audit")) write(path.join(zh, "translations", "new-by-audit.md"), "written by audit\n");
    return byName()(file, args);
  });
  const v = runGate(ctx, { exec });
  assert.equal(v.canOpenPr, false);
  assert.equal(v.verdict, "blocked");
  assert.ok(v.reasons.some((r) => r.includes("translations/new-by-audit.md")), JSON.stringify(v.reasons));
});

test("a change outside writeScope fails the gate, and a sync output change is blocked", () => {
  const { ctx, zh } = setup();
  write(path.join(zh, "scripts", "x.mjs"), "outside\n");
  const v1 = runGate(ctx, { exec: fakeExec(byName()) });
  assert.equal(v1.verdict, "fail");
  assert.deepEqual(v1.scope.outOfScope, ["scripts/x.mjs"]);
  write(path.join(zh, "data", "source", "s.md"), "sync output\n");
  const v2 = runGate(ctx, { exec: fakeExec(byName()) });
  assert.equal(v2.verdict, "fail", "the outside change is still there");
  assert.deepEqual(v2.scope.sync, ["data/source/s.md"]);
});

test("the gate itself leaves files, index and refs exactly as they were", () => {
  const { ctx, zh } = setup();
  write(path.join(zh, "translations", "pending.md"), "pending\n");
  const before = snapshotTree(zh);
  runGate(ctx, { exec: fakeExec(byName()) });
  assert.deepEqual(snapshotTree(zh), before);
});

test("the command lines pass version and repository explicitly, relative to the mono root", () => {
  const { ctx, mono } = setup();
  const exec = fakeExec(byName());
  runGate(ctx, { exec });
  const [status, audit, docs] = checkCalls(exec);
  assert.equal(status.cwd, mono);
  assert.equal(status.args[status.args.indexOf("--fail-on") + 1], FAIL_ON);
  assert.equal(FAIL_ON, "stale,failed,blocked,orphan,drift,glossary");
  assert.ok(status.args.includes("--verify"));
  assert.equal(status.args[status.args.indexOf("--source-root") + 1], "data/source", "relative to the zh repository, as tr.mjs resolves it");
  assert.deepEqual(audit.args.slice(-6), ["--mode", "audit", "--version", "v1.18", "--repo", "repos/v1.18_zh"]);
  assert.ok(docs.args.includes("--dry-run"));
  assert.equal(docs.args[docs.args.indexOf("--version") + 1], "v1.18");
  for (const c of checkCalls(exec)) for (const a of c.args) assert.equal(a.startsWith("/") || a.includes(".."), false, `argument ${a} must be relative to the mono root`);
});

test("--out inside the zh repository is refused, and a verdict file outside it is written", () => {
  const { mono, engine, zh } = setup();
  let err = "";
  const bad = main(["run", "--mono-root", mono, "--version", "v1.18", "--engine", engine, "--out", path.join(zh, "verdict.json")], {
    exec: fakeExec(byName()),
    out: () => {},
    err: (m) => (err += m),
    cwd: mono,
  });
  assert.equal(bad, 2);
  assert.match(err, /inside the zh repository/);
  const outFile = path.join(tmpDir("dapr-verdict-"), "verdict.json");
  const code = main(["run", "--mono-root", mono, "--version", "v1.18", "--engine", engine, "--out", outFile, "--json"], {
    exec: fakeExec(byName()),
    out: () => {},
    err: () => {},
    cwd: mono,
  });
  assert.equal(code, 0);
  const written = JSON.parse(readFileSync(outFile, "utf8"));
  assert.equal(written.canOpenPr, true);
  assert.equal(written.schema, 1);
});

test("plan prints the three commands and runs nothing", () => {
  const { mono, engine } = setup();
  const exec = fakeExec(byName());
  let text = "";
  const code = main(["plan", "--mono-root", mono, "--version", "v1.18", "--engine", engine], { exec, out: (m) => (text += m), err: () => {}, cwd: mono });
  assert.equal(code, 0);
  assert.equal(exec.calls.length, 0);
  assert.match(text, /zh-data-audit: pnpm run zh:data:repair --mode audit --version v1\.18 --repo repos\/v1\.18_zh/);
});

test("no version is a configuration error (exit 2) and nothing runs", () => {
  const lone = makeMono({ version: "v1.18", release: null });
  const exec = fakeExec(byName());
  let err = "";
  const code = main(["run", "--mono-root", lone.mono, "--engine", lone.engine], { exec, out: () => {}, err: (m) => (err += m), cwd: lone.mono });
  assert.equal(code, 2);
  assert.equal(exec.calls.length, 0);
  assert.match(err, /no version/);
});
