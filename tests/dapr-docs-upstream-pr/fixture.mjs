// Fixture for the upstream-PR tests: a mono root, a translation repo on v1.18_content, an upstream dapr/docs stand-in,
// a fork stand-in, and a fork checkout (repos/fork-docs) with a translations/docs-zh submodule. Local paths only.
// Not a test file.
import path from "node:path";
import { git, gitRepo, tmpDir, write } from "../_fixtures/mono.mjs";
import { spawnExec } from "../../dapr-docs-upstream-pr/scripts/lib/git.mjs";
import { statusDigest, statusEntries, headCommit } from "../../dapr-docs-upstream-pr/scripts/lib/git.mjs";

// The fork checkout adds a submodule from a local path, which git refuses unless file transport is allowed. Test-only.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";
process.env.GIT_AUTHOR_NAME ??= "t";
process.env.GIT_AUTHOR_EMAIL ??= "t@example.com";
process.env.GIT_COMMITTER_NAME ??= "t";
process.env.GIT_COMMITTER_EMAIL ??= "t@example.com";

const RELEASE = `schema: 1
version: v1.18
syncOutputPaths:
  - data/
upstreamPr:
  forkDocs:
    path: repos/fork-docs
    submodulePath: translations/docs-zh
    upstreamUrl: __UP__
    upstreamBranch: v1.18
`;

function bare(name, sourceWork) {
  const root = tmpDir("dapr-up-");
  const dir = path.join(root, `${name}.git`);
  git(root, ["init", "-q", "--bare", "-b", "main", dir]);
  git(sourceWork, ["push", "-q", dir, "--all"]);
  return dir;
}

/** Builds the whole fixture. Returns paths and helpers. */
export function makeFixture() {
  const root = tmpDir("dapr-upr-");
  const mono = path.join(root, "mono");

  // zh translation repo: main (for the submodule's default HEAD) and v1.18_content (what gets published)
  const zhLocal = path.join(mono, "repos", "v1.18_zh");
  gitRepo(zhLocal, { "translations/profile.yaml": 'schema: 1\nrepo: "repos/v1.18_zh"\n' });
  // translation remote: main only, so the translation branch is still to be pushed (stage A)
  const zhBare = bare("docs-zh", zhLocal);
  // upstream dapr/docs stand-in: v1.18 at U0 with the translations submodule in its history, later advanced to U1
  const upWork = path.join(root, "up-work");
  gitRepo(upWork, { "docs/a.md": "# a\n" });
  git(upWork, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", zhBare, "translations/docs-zh"]);
  git(upWork, ["commit", "-q", "-m", "add translations submodule"]);
  git(upWork, ["branch", "-f", "v1.18", "HEAD"]);
  const upBare = bare("docs", upWork);
  git(zhLocal, ["remote", "add", "origin", zhBare]);
  // the translation branch: a commit on top of main that the gate will vouch for
  git(zhLocal, ["checkout", "-q", "-b", "v1.18_content"]);
  write(path.join(zhLocal, "translations", "release.yaml"), RELEASE.replace("__UP__", upBare));
  write(path.join(zhLocal, "translated_content", "zh_CN", "a.md"), "译文\n");
  git(zhLocal, ["add", "-A"]);
  git(zhLocal, ["commit", "-q", "-m", "translations for v1.18"]);

  // fork stand-in: a bare copy of the upstream at U0, cloned to repos/fork-docs at branch v1.18, with the submodule
  const forkBare = path.join(root, "fork.git");
  git(root, ["clone", "-q", "--bare", upBare, forkBare]);
  const forkLocal = path.join(mono, "repos", "fork-docs");
  git(root, ["clone", "-q", "--branch", "v1.18", forkBare, forkLocal]);
  git(forkLocal, ["config", "user.name", "t"]);
  git(forkLocal, ["config", "user.email", "t@example.com"]);
  git(forkLocal, ["submodule", "update", "--init", "--", "translations/docs-zh"]);
  // upstream moves ahead: U1 on v1.18 (a descendant of U0), so the fork can fast-forward
  git(upWork, ["checkout", "-q", "v1.18"]);
  write(path.join(upWork, "docs", "b.md"), "# b\n");
  git(upWork, ["add", "-A"]);
  git(upWork, ["commit", "-q", "-m", "U1"]);
  git(upWork, ["push", "-q", upBare, "v1.18"]);
  git(upWork, ["checkout", "-q", "main"]);

  write(path.join(mono, ".hagicode", "monospecs.yaml"), `version: "1.0"\nrepositories:\n- path: "repos/v1.18_zh"\n  url: "${zhBare}"\n  branch: "v1.18_content"\n  optional: true\n`);
  return { root, mono, zhLocal, zhBare, upBare, forkBare, forkLocal, upWork };
}

/** A verdict as dapr-docs-translation-verify would write it, for the repository's current state. */
export function verdictFor(fx, overrides = {}) {
  const head = headCommit(spawnExec, fx.zhLocal);
  const digest = statusDigest(statusEntries(spawnExec, fx.zhLocal));
  return {
    schema: 1,
    canOpenPr: true,
    verdict: "pass",
    reasons: [],
    version: "v1.18",
    repo: "repos/v1.18_zh",
    headCommit: head,
    statusDigest: digest,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export { git, spawnExec };
