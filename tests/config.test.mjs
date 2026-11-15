import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, findMonoRoot, parseFlags, readRelease, repoRef, resolveContext, validateRelease } from "../dapr-docs-translate-incremental/scripts/lib/config.mjs";
import { agentSkillsDir, makeMono, tmpDir, write } from "./_fixtures/mono.mjs";

const RELEASE_V117 = `schema: 1
version: v1.17
syncOutputPaths:
  - data/
upstreamPr:
  forkDocs:
    path: repos/fork-docs
    submodulePath: translations/docs-zh
    upstreamUrl: https://github.com/dapr/docs.git
    upstreamBranch: v1.17
`;

test("the argument wins over release.yaml", () => {
  // release.yaml in the v1.18 checkout still says v1.17: the argument must win
  const { mono } = makeMono({ version: "v1.18", release: RELEASE_V117 });
  const ctx = resolveContext({ monoRoot: mono, version: "v1.18" });
  assert.equal(ctx.version, "v1.18");
  assert.equal(ctx.versionSource, "argument");
  assert.equal(ctx.zh.rel, "repos/v1.18_zh");
});

test("without an argument the version comes from release.yaml", () => {
  const { mono } = makeMono({ version: "v1.18", release: RELEASE_V117.replaceAll("v1.17", "v1.18") });
  const ctx = resolveContext({ monoRoot: mono, zhRepo: "repos/v1.18_zh" });
  assert.equal(ctx.version, "v1.18");
  assert.equal(ctx.versionSource, "release.yaml");
  assert.equal(ctx.release.upstreamPr.forkDocs.upstreamBranch, "v1.18");
});

test("no version from any source is an error, never a built-in default", () => {
  const { mono } = makeMono({ version: "v1.18", release: null });
  assert.throws(() => resolveContext({ monoRoot: mono }), (e) => e instanceof ConfigError && /no version/.test(e.message));
  assert.throws(() => resolveContext({ monoRoot: mono, zhRepo: "repos/v1.18_zh" }), (e) => e instanceof ConfigError && /no version/.test(e.message));
});

test("a release.yaml without version is reported by field name and not filled in", () => {
  const { mono } = makeMono({ version: "v1.18", release: RELEASE_V117.replace("version: v1.17\n", "") });
  assert.throws(() => resolveContext({ monoRoot: mono, zhRepo: "repos/v1.18_zh" }), (e) => e instanceof ConfigError && /missing version/.test(e.message));
});

test("the mono root is found from a subdirectory", () => {
  const { mono } = makeMono({ version: "v1.18" });
  const sub = path.join(mono, "repos", "v1.18_zh", "translations");
  assert.equal(findMonoRoot(sub), mono);
});

test("no monospecs above the start directory is an error", () => {
  const lone = tmpDir("dapr-lone-");
  assert.throws(() => findMonoRoot(lone), (e) => e instanceof ConfigError && /monospecs/.test(e.message));
});

test("a repository argument is stored relative to the mono root, whatever its form", () => {
  const { mono, zh } = makeMono({ version: "v1.18" });
  assert.equal(repoRef(mono, "repos/v1.18_zh").rel, "repos/v1.18_zh");
  assert.equal(repoRef(mono, zh).rel, "repos/v1.18_zh");
  assert.equal(repoRef(mono, "repos/v1.18_zh").entry.branch, "v1.18_content");
});

test("the release.example.yaml template passes the structure check", () => {
  const r = readRelease(path.join(agentSkillsDir, "release.example.yaml"));
  assert.equal(r.valid, true, JSON.stringify(r));
  assert.equal(r.value.version, "v1.17");
});

test("validateRelease names each missing required field", () => {
  const text = readFileSync(path.join(agentSkillsDir, "release.example.yaml"), "utf8").replace(/^version: .*$/m, "");
  const file = write(path.join(tmpDir(), "release.yaml"), text);
  const r = readRelease(file);
  assert.equal(r.valid, false);
  assert.deepEqual(r.missing, ["version"]);
});

test("validateRelease reports a missing forkDocs field by its dotted name", () => {
  const r = validateRelease({ schema: 1, version: "v1.18", syncOutputPaths: [], upstreamPr: { forkDocs: { path: "x" } } });
  assert.deepEqual(r.missing, [
    "upstreamPr.forkDocs.submodulePath",
    "upstreamPr.forkDocs.upstreamUrl",
    "upstreamPr.forkDocs.upstreamBranch",
  ]);
});

test("parseFlags reads values, equals forms, booleans and repeatable flags", () => {
  const f = parseFlags(["--version", "v1.18", "--zh-repo=repos/v1.18_zh", "--execute", "--confirm", "abc", "--multi", "a", "--multi", "b"], {
    boolean: ["execute"],
    multi: ["multi"],
  });
  assert.equal(f.version, "v1.18");
  assert.equal(f["zh-repo"], "repos/v1.18_zh");
  assert.equal(f.execute, true);
  assert.equal(f.confirm, "abc");
  assert.deepEqual(f.multi, ["a", "b"]);
  assert.throws(() => parseFlags(["--version"]), ConfigError);
});
