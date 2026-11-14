// Shared fixtures for the dapr-docs-translation tests. Everything happens in temp directories; nothing touches a real repository.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dapr-docs-translation");
export const scripts = path.join(skillDir, "scripts");
export const libUrl = (name) => path.join(scripts, "lib", name);

const cleanup = [];
process.on("exit", () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});
export const tmpDir = (prefix = "dt-") => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
};

export const node = (script, args = [], options = {}) => spawnSync("node", [path.join(scripts, script), ...args], { encoding: "utf8", ...options });
export const tr = (...args) => node("tr.mjs", args);
export const statectl = (...args) => node("statectl.mjs", args);
export const trJson = (...args) => {
  const r = tr(...args, "--json");
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* leave null; the test will show stderr */
  }
  return { ...r, json };
};

export const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
export const read = (file) => readFileSync(file, "utf8");
export const readJsonFile = (file) => JSON.parse(readFileSync(file, "utf8"));
export const sha = (file) => spawnSync("sha256sum", [file], { encoding: "utf8" }).stdout.split(" ")[0];

/** A minimal English document with a title, a heading and a body line. */
export const doc = (title, body = "Hello.") => `---\ntitle: "${title}"\n---\n\n# ${title}\n\n${body}\n`;

/**
 * A site repo scaffolded by `tr init` with source files under docs/.
 *   makeSite({ sources: {"a.md": "..."}, locales: ["zh-CN"], initArgs: [...] }) → { repo, profile, src(rel,text), content(locale,rel), state(locale) }
 */
export function makeSite({ sources = {}, locales = ["zh-CN"], initArgs = [] } = {}) {
  const repo = tmpDir("dt-site-");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  const args = ["init", "--repo", repo, "--source-root", "docs", "--glob", "**/*.md", ...locales.flatMap((l) => ["--locale", l]), ...initArgs];
  const r = tr(...args);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}`);
  const site = {
    repo,
    profile: path.join(repo, "translations/profile.yaml"),
    src: (rel, text) => write(path.join(repo, "docs", rel), text),
    content: (locale, rel) => path.join(repo, "translations/locales", locale, "content", rel),
    state: (locale) => path.join(repo, "translations/locales", locale, "state"),
    glossaryDir: (locale) => path.join(repo, "translations/locales", locale, "glossary"),
  };
  for (const [rel, text] of Object.entries(sources)) site.src(rel, text);
  return site;
}

/** Replace the profile with `edit(profileText)`. */
export const editProfile = (site, edit) => write(site.profile, edit(read(site.profile)));

/** Run git in a directory with a fixed identity and optional commit date. */
export const git = (cwd, args, date) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });

export const hasDiffTool = spawnSync("diff", ["--version"], { encoding: "utf8" }).status === 0;
