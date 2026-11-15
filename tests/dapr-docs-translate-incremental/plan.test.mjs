import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext, buildPlan, main } from "../../dapr-docs-translate-incremental/scripts/incremental.mjs";
import { DEFAULT_PROFILE, makeMono, write } from "../_fixtures/mono.mjs";
import path from "node:path";

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

const FORBIDDEN = ["git push", "git branch", "git switch -c", "git checkout", "git stash", "git reset", "--no-verify", "adopt"];

test("plan lists the five steps in order, with the version and repository arguments", () => {
  const { mono, engine } = makeMono({ version: "v1.18" });
  const plan = buildPlan(buildContext({ monoRoot: mono, version: "v1.18", engine }));
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(plan.steps[0].args, ["run", "sync:repos"]);
  const sync = plan.steps[1].args;
  assert.equal(sync[sync.indexOf("--version") + 1], "v1.18");
  assert.equal(sync[sync.indexOf("--zh-repo") + 1], "repos/v1.18_zh");
  assert.equal(sync[sync.indexOf("--source-repo") + 1], "repos/v1.18");
  const scan = plan.steps[2].args;
  assert.equal(scan[scan.indexOf("--profile") + 1], "repos/v1.18_zh/translations/profile.yaml");
  assert.equal(scan[scan.indexOf("--source-root") + 1], "repos/v1.18_zh/data/source");
  assert.equal(plan.steps[3].kind, "agent");
  assert.equal(plan.steps[4].name, "status");
});

test("the source root comes from the profile's sources.glob.root", () => {
  const profile = DEFAULT_PROFILE.replace('root: "data/source"', 'root: "data/alt"');
  const { mono, engine } = makeMono({ version: "v1.18", profile });
  const plan = buildPlan(buildContext({ monoRoot: mono, version: "v1.18", engine }));
  const scan = plan.steps[2].args;
  assert.equal(scan[scan.indexOf("--source-root") + 1], "repos/v1.18_zh/data/alt");
});

test("the plan contains none of the forbidden commands", () => {
  const { mono, engine } = makeMono({ version: "v1.18", release: RELEASE_V118 });
  const text = JSON.stringify(buildPlan(buildContext({ monoRoot: mono, version: "v1.18", engine })));
  for (const bad of FORBIDDEN) assert.equal(text.includes(bad), false, `plan must not contain "${bad}"`);
});

test("without --version the version is read from the zh repo's release.yaml", () => {
  const { mono, engine } = makeMono({ version: "v1.18", release: RELEASE_V118 });
  const plan = buildPlan(buildContext({ monoRoot: mono, zhRepo: "repos/v1.18_zh", engine }));
  assert.equal(plan.version, "v1.18");
  assert.equal(plan.versionSource, "release.yaml");
});

test("a run with no version from any source exits 2 and says why", () => {
  const { mono, engine } = makeMono({ version: "v1.18", release: null });
  let err = "";
  const code = main(["plan", "--mono-root", mono, "--engine", engine], { out: () => {}, err: (m) => (err += m), cwd: mono });
  assert.equal(code, 2);
  assert.match(err, /no version/);
});

test("the mono root is found from a subdirectory when --mono-root is not given", () => {
  const { mono, engine } = makeMono({ version: "v1.18" });
  const sub = path.join(mono, "repos", "v1.18_zh", "translations");
  write(path.join(sub, ".keep"), "");
  let text = "";
  const code = main(["plan", "--version", "v1.18", "--engine", engine, "--json"], { out: (m) => (text = m), err: () => {}, cwd: sub });
  assert.equal(code, 0);
  assert.equal(JSON.parse(text).zhRepo, "repos/v1.18_zh");
});
