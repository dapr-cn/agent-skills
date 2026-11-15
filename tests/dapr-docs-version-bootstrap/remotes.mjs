// Local bare repositories standing in for dapr/docs (upstream) and dapr/docs-zh (translations), plus a mono root whose
// monospecs points at them. Nothing here touches the network. Not a test file.
import path from "node:path";
import { DEFAULT_PROFILE, git, gitRepo, tmpDir, write } from "../_fixtures/mono.mjs";

// Commit identity for the git runs the code under test makes (clone, commit): the user's own identity is not available in tests.
process.env.GIT_AUTHOR_NAME ??= "t";
process.env.GIT_AUTHOR_EMAIL ??= "t@example.com";
process.env.GIT_COMMITTER_NAME ??= "t";
process.env.GIT_COMMITTER_EMAIL ??= "t@example.com";

/** Creates a bare repository whose branches are all `branches` (each branch gets its own commit). */
function bareWith(name, branches, files = {}) {
  const root = tmpDir("dapr-remote-");
  const work = path.join(root, "work");
  gitRepo(work, { "README.md": `${name}\n`, ...files });
  for (const b of branches) {
    git(work, ["branch", "-f", b.name, "HEAD"]);
  }
  for (const b of branches) {
    git(work, ["checkout", "-q", b.name]);
    write(path.join(work, "marker.txt"), `${b.name}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", `${b.name} content`]);
  }
  git(work, ["checkout", "-q", "main"]);
  const bare = path.join(root, `${name}.git`);
  git(root, ["init", "-q", "--bare", bare]);
  git(work, ["push", "-q", bare, ...branches.map((b) => b.name), "main"]);
  return { bare, work };
}

const branch = (name) => ({ name });

/**
 * Upstream with v1.15..v1.18 docs branches; translations with v1.15_content and v1.17_content (and an ignored
 * new_content_v1.9 name). The mono root's monospecs knows repos/v1.17 and repos/v1.17_zh at those remotes.
 */
export function makeRemotes({ upstreamVersions = ["v1.15", "v1.16", "v1.17", "v1.18"], contentVersions = ["v1.15", "v1.17"] } = {}) {
  const up = bareWith("docs", upstreamVersions.map(branch));
  const zhBranches = [...contentVersions.map((v) => branch(`${v}_content`)), branch("new_content_v1.9")];
  const zh = bareWith(
    "docs-zh",
    zhBranches,
    {
      "translations/profile.yaml": DEFAULT_PROFILE.replace('repo: "repos/v1.18_zh"', 'repo: "repos/v1.17_zh"').replace('"fixture"', '"English Dapr v1.17 documentation mirror under data/source, refreshed from repos/v1.17."'),
      "translations/keep.md": "keep\n",
      "translated_content/x.md": "x\n",
    },
  );
  const mono = tmpDir("dapr-boot-mono-");
  write(path.join(mono, ".hagicode", "monospecs.yaml"), monospecsText({ up: up.bare, zh: zh.bare }));
  const engine = path.join(mono, "repos", "agent-skills", "dapr-docs-translation");
  write(path.join(engine, "scripts", "tr.mjs"), "// stub\n");
  return { mono, up, zh, engine };
}

export function monospecsText({ up, zh, prevVersion = "v1.17" }) {
  return `version: "1.0"

# fixture monospecs: the previous version's entries carry the URLs the bootstrap copies
repositories:
- path: "repos/${prevVersion}"
  url: "${up}"
  displayName: "${prevVersion}"
  branch: "${prevVersion}"
  optional: true
  tags: [ data, upstream, source ]
  status: "active"
  note: "fixture upstream"

- path: "repos/${prevVersion}_zh"
  url: "${zh}"
  displayName: "${prevVersion}_zh"
  branch: "${prevVersion}_content"
  optional: true
  tags: [ data, zh-official ]
  status: "active"
  note: "fixture translations"
`;
}

/** Pushes a new commit to a branch of a bare remote, through its work clone. */
export function advanceRemote(work, bare, branchName) {
  git(work, ["checkout", "-q", branchName]);
  write(path.join(work, "moved.txt"), `${Date.now()}\n`);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", `advance ${branchName}`]);
  git(work, ["push", "-q", bare, branchName]);
  git(work, ["checkout", "-q", "main"]);
}

