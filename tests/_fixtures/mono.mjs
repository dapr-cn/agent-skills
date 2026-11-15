// Shared fixtures for the dapr-docs-* skill tests. Everything happens in temp directories; nothing touches a real repository.
// Not a test file: `npm test` only runs *.test.mjs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnExec } from "../../dapr-docs-translate-incremental/scripts/lib/git.mjs";

export const agentSkillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const cleanup = [];
process.on("exit", () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

export function tmpDir(prefix = "dapr-skill-") {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

export const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};

export const git = (cwd, args) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  });

export function gitRepo(dir, files = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  // the code under test runs plain `git commit`, so the temp repository needs its own identity
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

export const DEFAULT_PROFILE = `schema: 1
repo: "repos/v1.18_zh"
translationsRoot: translations
defaultLocale: zh-CN
sources:
  description: "fixture"
  glob:
    root: "data/source"
    include: ["**/*.md"]
    exclude: []
output:
  template: "translated_content/zh_CN/{doc}"
writeScope: [translations/, translated_content/]
readOnly:
  - data/
  - site/
  - scripts/
commit:
  enabled: false
  messagePrefix: "docs(translation)"
  trailer: ""
`;

export const DEFAULT_MONOSPECS = (version) => `version: "1.0"

repositories:
- path: "repos/${version}"
  url: "https://github.com/dapr/docs.git"
  displayName: "${version}"
  branch: "${version}"
  tags: [ data, upstream, source ]
  status: "active"
  note: "fixture upstream"

- path: "repos/${version}_zh"
  url: "https://github.com/dapr/docs-zh.git"
  displayName: "${version}_zh"
  branch: "${version}_content"
  tags: [ data, zh-official ]
  status: "active"
  note: "fixture translations"

- path: "repos/v1.17_zh"
  url: "https://github.com/dapr/docs-zh.git"
  displayName: "v1.17_zh"
  branch: "v1.17_content"
  optional: true
  tags: [ data, zh-official ]
  status: "active"
  note: "previous version"
`;

/**
 * A mono root with .hagicode/monospecs.yaml and repos/<version>_zh as a git repository (translations/ and translated_content/
 * and data/ exist). Options:
 *   version: the target version; release: release.yaml text (or null for none); profile: profile.yaml text;
 *   zhFiles / srcFiles: { "rel": "text" } committed into the zh repo and the upstream checkout.
 * Returns { mono, zh, src, version, engine } where engine is a stub directory holding scripts/tr.mjs.
 */
export function makeMono({ version = "v1.18", release = null, profile = DEFAULT_PROFILE, zhFiles = {}, srcFiles = {}, monospecs } = {}) {
  const mono = tmpDir("dapr-mono-");
  write(path.join(mono, ".hagicode", "monospecs.yaml"), monospecs ?? DEFAULT_MONOSPECS(version));
  const zh = path.join(mono, "repos", `${version}_zh`);
  gitRepo(zh, {
    "translations/profile.yaml": profile,
    "translations/.gitkeep": "",
    "translated_content/.gitkeep": "",
    "data/.gitkeep": "",
    ...zhFiles,
  });
  if (release !== null) write(path.join(zh, "translations", "release.yaml"), release);
  const src = path.join(mono, "repos", version);
  write(path.join(src, "README.md"), "# upstream\n");
  for (const [rel, text] of Object.entries(srcFiles)) write(path.join(src, rel), text);
  // same layout as the real repository: the engine sits next to the skills, inside the mono root
  const engine = path.join(mono, "repos", "agent-skills", "dapr-docs-translation");
  write(path.join(engine, "scripts", "tr.mjs"), "// stub engine: never executed by these tests\n");
  return { mono, zh, src, version, engine };
}

/** A fake exec for injected commands. `handler(file, args, opts)` returns { status, stdout, stderr }. Every call is recorded. */
export function fakeExec(handler = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const exec = (file, args, opts = {}) => {
    calls.push({ file, args: [...args], cwd: opts.cwd });
    // git runs for real (on the temp repositories) so statuses and HEAD are genuine; only the commands under test are faked
    if (file === "git") return spawnExec(file, args, opts);
    const r = handler(file, args, opts);
    // an explicit `status: null` means "no exit code" (the program did not start); only a missing key defaults to 0
    const status = Object.prototype.hasOwnProperty.call(r, "status") ? r.status : 0;
    return { status, signal: null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
  };
  exec.calls = calls;
  return exec;
}

/**
 * A digest of a directory: every file's relative path and content hash (excluding .git), plus the git status and HEAD
 * when it is a repository. Two equal digests mean dry-runs changed nothing observable.
 */
export function snapshotTree(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[path.relative(dir, abs)] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(dir);
  const status = existsSync(path.join(dir, ".git")) ? git(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout : null;
  const head = existsSync(path.join(dir, ".git")) ? git(dir, ["rev-parse", "HEAD"]).stdout.trim() : null;
  const refs = existsSync(path.join(dir, ".git")) ? git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout : null;
  const index = existsSync(path.join(dir, ".git", "index")) ? createHash("sha256").update(readFileSync(path.join(dir, ".git", "index"))).digest("hex") : null;
  return { files, status, head, refs, index };
}
