// Configuration resolution for the dapr-docs-* skills. Node built-ins only.
// Copied verbatim into every skill's scripts/lib/ (tests/shared-lib-sync.test.mjs keeps the copies identical: edit all of them together).
// Finds the mono root, the version, the repositories and their monospecs entries, release.yaml, profile.yaml and the engine.
// It never guesses: a missing input is a ConfigError, and no version is ever taken from a built-in default.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseYaml } from "./yaml.mjs";

export const MONOSPECS = path.join(".hagicode", "monospecs.yaml");
export const VERSION_RE = /^v\d+\.\d+$/;

export class ConfigError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "ConfigError";
    this.exitCode = exitCode;
  }
}

export const normRel = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** Walk up from `start` to the first directory that holds .hagicode/monospecs.yaml. */
export function findMonoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, MONOSPECS))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new ConfigError(`no ${MONOSPECS} in ${path.resolve(start)} or any parent directory; run this inside the mono repository or pass --mono-root`);
    dir = up;
  }
}

export function loadMonospecs(monoRoot) {
  const doc = parseYaml(readFileSync(path.join(monoRoot, MONOSPECS), "utf8"));
  return Array.isArray(doc?.repositories) ? doc.repositories : [];
}

/** The monospecs entry whose path is `rel` (relative to the mono root), or null. */
export function repoEntry(monoRoot, rel) {
  const want = normRel(rel);
  return loadMonospecs(monoRoot).find((r) => normRel(r.path ?? "") === want) ?? null;
}

/** A repository argument. Relative paths are relative to the mono root; `rel` in the result always is. */
export function repoRef(monoRoot, input) {
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(monoRoot, input);
  const rel = normRel(path.relative(monoRoot, abs));
  return { rel, abs, entry: repoEntry(monoRoot, rel) };
}

const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

export const RELEASE_FIELDS = [
  "schema",
  "version",
  "syncOutputPaths",
  "upstreamPr.forkDocs.path",
  "upstreamPr.forkDocs.submodulePath",
  "upstreamPr.forkDocs.upstreamUrl",
  "upstreamPr.forkDocs.upstreamBranch",
];

/** Structure check for translations/release.yaml. Lists missing fields by name; never fills a default. */
export function validateRelease(obj) {
  const missing = RELEASE_FIELDS.filter((f) => {
    const v = get(obj, f);
    return v === undefined || v === null || v === "";
  });
  const problems = [];
  if (missing.length === 0) {
    if (obj.schema !== 1) problems.push("schema must be 1");
    if (!VERSION_RE.test(String(obj.version))) problems.push(`version "${obj.version}" must look like vX.Y`);
    if (!Array.isArray(obj.syncOutputPaths) || obj.syncOutputPaths.some((p) => typeof p !== "string")) problems.push("syncOutputPaths must be a list of paths");
    if (obj.previousVersion !== undefined && !VERSION_RE.test(String(obj.previousVersion))) problems.push(`previousVersion "${obj.previousVersion}" must look like vX.Y`);
    for (const f of RELEASE_FIELDS.slice(3)) if (typeof get(obj, f) !== "string") problems.push(`${f} must be a string`);
  }
  return { missing, problems, valid: missing.length === 0 && problems.length === 0 };
}

/** Reads and checks release.yaml. Returns null when the file does not exist. */
export function readRelease(file) {
  if (!existsSync(file)) return null;
  let value;
  try {
    value = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    return { file, value: null, missing: [], problems: [error.message], valid: false };
  }
  return { file, value, ...validateRelease(value) };
}

/**
 * Resolves what a run is about. Precedence for the version: the argument, then translations/release.yaml,
 * then an error. The zh repo comes from --zh-repo, else repos/<version>_zh. Its URL and branch come from monospecs only.
 */
export function resolveContext({ cwd = process.cwd(), monoRoot, version, zhRepo, sourceRepo } = {}) {
  const root = monoRoot ? path.resolve(monoRoot) : findMonoRoot(cwd);
  if (version !== undefined && !VERSION_RE.test(version)) throw new ConfigError(`--version "${version}" must look like vX.Y`);
  if (zhRepo === undefined && version === undefined) {
    throw new ConfigError("no version: pass --version vX.Y, or --zh-repo <dir> whose translations/release.yaml names the version");
  }
  const zh = repoRef(root, zhRepo ?? `repos/${version}_zh`);
  const releaseFile = path.join(zh.abs, "translations", "release.yaml");
  const release = readRelease(releaseFile);
  let resolvedVersion;
  let versionSource;
  if (version !== undefined) {
    resolvedVersion = version;
    versionSource = "argument";
  } else if (release?.valid) {
    resolvedVersion = release.value.version;
    versionSource = "release.yaml";
  } else if (release) {
    throw new ConfigError(`${releaseFile} is invalid (${[...release.missing.map((m) => `missing ${m}`), ...release.problems].join("; ")}); fix it or pass --version`);
  } else {
    throw new ConfigError(`no version: pass --version vX.Y, or add ${releaseFile}`);
  }
  const source = repoRef(root, sourceRepo ?? `repos/${resolvedVersion}`);
  return {
    monoRoot: root,
    version: resolvedVersion,
    versionSource,
    zh,
    source,
    releaseFile,
    releaseCheck: release,
    release: release?.valid ? release.value : null,
    profileFile: path.join(zh.abs, "translations", "profile.yaml"),
  };
}

export function readProfile(file) {
  if (!existsSync(file)) throw new ConfigError(`profile not found: ${file}`);
  return parseYaml(readFileSync(file, "utf8"));
}

/** The directory the engine reads sources from: profile sources.glob.root, relative to the zh repo. */
export const sourceRootOf = (zhAbs, profile) => path.resolve(zhAbs, profile?.sources?.glob?.root ?? ".");
export const writeScopeOf = (profile) => (Array.isArray(profile?.writeScope) ? profile.writeScope.map(normRel) : []);

/** The engine lives next to this skill's folder: <agent-skills>/dapr-docs-translation. --engine overrides. */
export function resolveEngine({ skillDir, override, cwd = process.cwd() }) {
  const dir = override ? path.resolve(cwd, override) : path.resolve(skillDir, "..", "dapr-docs-translation");
  const tr = path.join(dir, "scripts", "tr.mjs");
  if (!existsSync(tr)) throw new ConfigError(`engine not found at ${tr}; pass --engine <dir> to point at dapr-docs-translation`);
  return { dir, tr };
}

/** Minimal flag parser: `--name value`, `--name=value`, boolean flags listed in `boolean`, repeatable flags in `multi`. */
export function parseFlags(argv, { boolean = [], multi = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (boolean.includes(name)) {
      out[name] = eq >= 0 ? arg.slice(eq + 1) !== "false" : true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[(i += 1)];
    if (value === undefined || value.startsWith("--")) throw new ConfigError(`missing value for --${name}`);
    if (multi.includes(name)) (out[name] ??= []).push(value);
    else out[name] = value;
  }
  return out;
}
