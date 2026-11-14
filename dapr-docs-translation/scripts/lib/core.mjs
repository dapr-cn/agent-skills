// Read-only core of tr.mjs: profile loading, source discovery, snapshot loading, per-document classification,
// work planning and completeness figures. Nothing in this file writes to the target repository.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { baseSourcePath, ledgerTail, loadSnapshotChain, lockHeld, sha256 } from "./state.mjs";
import { parseYaml } from "./yaml.mjs";

export { sha256 };
const posix = (p) => p.split(path.sep).join("/");

/** Classes that still need translation work, with the rank used when picking (lower first). */
export const PENDING_RANK = { interrupted: 0, stale: 0, drift: 1, new: 2, failed: 2, missing: 2 };
export const CLASSES = ["fresh", "edited", "new", "stale", "drift", "missing", "failed", "interrupted", "blocked", "untracked", "orphan", "superseded", "external"];

// ---------------------------------------------------------------------------------------------- profile

export function loadProfile(profilePath, { repo, runDir = process.cwd() } = {}) {
  const file = path.resolve(runDir, profilePath);
  if (!existsSync(file)) throw new Error(`profile not found: ${file}`);
  let profile;
  try {
    profile = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
  if (profile?.schema !== 1) throw new Error(`${file}: expected "schema: 1"`);
  if (typeof profile.translationsRoot !== "string" || !profile.translationsRoot) throw new Error(`${file}: "translationsRoot" is required`);
  if (!profile.locales || typeof profile.locales !== "object") throw new Error(`${file}: "locales" is required`);
  const t = profile.translationsRoot.replace(/\/+$/, "");
  let repoRoot;
  if (repo) repoRoot = path.resolve(runDir, repo);
  else if (posix(file).endsWith(`/${t}/profile.yaml`)) repoRoot = file.slice(0, file.length - `/${t}/profile.yaml`.length);
  else if (typeof profile.repo === "string") repoRoot = path.resolve(runDir, profile.repo);
  else throw new Error(`cannot locate the repository: pass --repo (profile is not at <repo>/${t}/profile.yaml)`);
  if (!existsSync(repoRoot)) throw new Error(`repository root does not exist: ${repoRoot}`);
  return { profile, profileFile: file, repo: repoRoot, translationsRoot: path.join(repoRoot, t) };
}

export function localePaths(ctx, locale) {
  const dir = path.join(ctx.translationsRoot, "locales", locale);
  return { dir, content: path.join(dir, "content"), drafts: path.join(dir, "drafts"), state: path.join(dir, "state"), glossary: path.join(dir, "glossary") };
}

/** Where a document's accepted translation lives: profile `output.template` ({locale}, {dir}, {doc}) or <T>/locales/<L>/content/<doc>. */
export function contentPath(ctx, locale, doc) {
  const template = ctx.profile.output?.template;
  if (!template) return path.join(localePaths(ctx, locale).content, doc);
  const dir = ctx.profile.locales[locale]?.dir ?? locale;
  const abs = path.resolve(ctx.repo, template.replaceAll("{locale}", locale).replaceAll("{dir}", dir).replaceAll("{doc}", doc));
  if (!abs.startsWith(`${ctx.repo}${path.sep}`)) throw new Error(`output.template puts "${doc}" outside the repository: ${abs}`);
  return abs;
}

/** Locales a command applies to: one, or every declared locale for "all". */
export function pickLocales(profile, requested) {
  if (requested === "all") return Object.keys(profile.locales);
  return [pickLocale(profile, requested)];
}

export function pickLocale(profile, requested) {
  const locale = requested ?? profile.defaultLocale;
  if (!locale) throw new Error("no locale: pass --locale or set defaultLocale in the profile");
  if (!profile.locales[locale]) throw new Error(`locale "${locale}" is not declared in the profile (declared: ${Object.keys(profile.locales).join(", ")})`);
  return locale;
}

// ---------------------------------------------------------------------------------------------- discovery

function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) throw new Error(`unbalanced "{" in glob ${pattern}`);
      out += `(?:${pattern.slice(i + 1, end).split(",").map((alt) => alt.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
export const globMatcher = (patterns) => {
  const res = patterns.map(globToRegExp);
  return (rel) => res.some((re) => re.test(rel));
};

function walk(root, rel = "") {
  const out = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function gitHead(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function parseNdjson(text, origin) {
  const docs = [];
  let meta = {};
  text.split("\n").filter((l) => l.trim()).forEach((line, k) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${origin}: line ${k + 1} is not JSON: ${line.slice(0, 80)}`);
    }
    if (row._meta) meta = { ...meta, ...row._meta };
    else if (typeof row.doc === "string" && typeof row.sha256 === "string") docs.push({ doc: row.doc, bytes: Number(row.bytes ?? 0), sha256: row.sha256, external: Boolean(row.external), path: row.path ?? null });
    else throw new Error(`${origin}: line ${k + 1} needs "doc" and "sha256"`);
  });
  return { meta, docs };
}

/**
 * Source documents for a locale. Three ways, first match wins:
 *   discoveryFile  — a pre-made NDJSON file (tests, offline runs);
 *   sources.glob   — built-in: { root, include: [globs], exclude?: [globs] } relative to the repo;
 *   sources.discovery — the repository's own read-only adapter (NDJSON contract, see references/profile-spec.md).
 * Returns { docs: [{doc, bytes, sha256, external, abs}], sourceRevision, sourceRoot, via }. `abs` is the source file path when known.
 */
export function discover(ctx, locale, { discoveryFile, sourceRoot, timeoutSeconds = 300, noExec = false } = {}) {
  const sources = ctx.profile.sources ?? {};
  let parsed;
  let via;
  let root = null;
  if (discoveryFile) {
    parsed = parseNdjson(readFileSync(discoveryFile, "utf8"), discoveryFile);
    via = `file:${discoveryFile}`;
  } else if (sources.glob) {
    const g = sources.glob;
    root = path.resolve(ctx.repo, g.root ?? ".");
    if (!existsSync(root)) throw new Error(`sources.glob.root does not exist: ${root}`);
    const include = globMatcher([].concat(g.include ?? ["**/*.md", "**/*.mdx"]));
    const exclude = g.exclude?.length ? globMatcher([].concat(g.exclude)) : () => false;
    const docs = walk(root)
      .filter((rel) => include(rel) && !exclude(rel))
      .filter((rel) => !path.resolve(root, rel).startsWith(`${ctx.translationsRoot}${path.sep}`))
      .sort()
      .map((rel) => {
        const buf = readFileSync(path.join(root, rel));
        return { doc: rel, bytes: buf.length, sha256: sha256(buf), external: false, path: null };
      });
    parsed = { meta: { sourceRevision: gitHead(root) }, docs };
    via = `glob:${posix(path.relative(ctx.repo, root)) || "."}`;
  } else if (sources.discovery?.command) {
    if (noExec) throw new Error("--no-exec: this profile's sources.discovery.command would run a shell command; use sources.glob or --discovery-file");
    const cwd = path.resolve(ctx.repo, sources.discovery.cwd ?? ".");
    const command = String(sources.discovery.command).replaceAll("{locale}", locale);
    const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutSeconds * 1000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw new Error(`discovery command failed to run (${r.error.code ?? r.error.message}): ${command}`);
    if (r.status !== 0) throw new Error(`discovery command exited ${r.status}: ${command}\n${r.stderr.trim().split("\n").slice(-5).join("\n")}`);
    parsed = parseNdjson(r.stdout, "discovery output");
    via = `command:${command}`;
  } else {
    throw new Error("the profile has neither sources.glob nor sources.discovery.command");
  }
  const metaRoot = sourceRoot ?? parsed.meta.sourceRoot ?? null;
  if (metaRoot) root = path.resolve(ctx.repo, metaRoot);
  const docs = parsed.docs.map((d) => ({ ...d, abs: d.path ? path.resolve(ctx.repo, d.path) : root ? path.join(root, d.doc) : null }));
  const seen = new Set();
  for (const d of docs) {
    if (seen.has(d.doc)) throw new Error(`discovery lists "${d.doc}" twice`);
    seen.add(d.doc);
  }
  return { docs, sourceRevision: parsed.meta.sourceRevision ?? null, sourceRoot: root, via };
}

// ---------------------------------------------------------------------------------------------- state (read-only)

/** snapshot.json → newest valid backup → ledger replay → empty (same order as `statectl snapshot load`). */
export function loadSnapshot(stateDir) {
  return loadSnapshotChain(stateDir);
}

export function glossaryInfo(paths, snapshot) {
  const file = path.join(paths.glossary, "glossary.json");
  let pending = null;
  try {
    pending = JSON.parse(readFileSync(path.join(paths.glossary, "pending.json"), "utf8"));
  } catch {
    /* no pending list yet */
  }
  const pendingCount = pending?.entries?.length ?? 0;
  if (!existsSync(file)) return { exists: false, file, data: null, version: null, sha256: null, snapshotSha256: snapshot.glossarySha256 ?? null, changedOutsideRun: false, pending, pendingCount };
  const buf = readFileSync(file);
  let version = null;
  let data = null;
  try {
    data = JSON.parse(buf.toString("utf8"));
    version = data.version ?? null;
  } catch {
    /* reported through version === null */
  }
  const digest = sha256(buf);
  return { exists: true, file, data, version, sha256: digest, snapshotSha256: snapshot.glossarySha256 ?? null, changedOutsideRun: Boolean(snapshot.glossarySha256) && snapshot.glossarySha256 !== digest, pending, pendingCount };
}

// ---------------------------------------------------------------------------------------------- classification

function tierOf(doc, priority = []) {
  const hit = [...priority].sort((a, b) => a.tier - b.tier).find((p) => (p.match ?? []).some((m) => doc === m || doc.startsWith(m)));
  return hit ? hit.tier : 3;
}

function fileSha(p) {
  try {
    return statSync(p).isFile() ? sha256(readFileSync(p)) : null;
  } catch {
    return null;
  }
}

/** One document → { class, reason, edited }. See references/state-and-recovery.md §5 for the table this implements. */
export function classify(d, snap, diskSha) {
  const hasFile = diskSha !== null;
  const edited = Boolean(snap?.translationSha256) && hasFile && diskSha !== snap.translationSha256;
  if (d.external) return { class: hasFile || snap ? "superseded" : "external", reason: "an external (upstream) translation exists", edited: false };
  if (!snap) return hasFile ? { class: "untracked", reason: "a translation file exists but the state has no record of it", edited: false } : { class: "new", reason: "no translation yet", edited: false };
  const st = snap.status;
  if (st === "blocked" || ((st === "failed" || st === "interrupted") && (snap.attempts ?? 0) >= 3)) return { class: "blocked", reason: `attempts=${snap.attempts ?? "?"}; reset attempts to 0 in snapshot.json to retry`, edited };
  if (st === "failed" || st === "interrupted") return { class: st, reason: st === "failed" ? "last attempt failed verification" : "an earlier run stopped mid-document", edited };
  if (["done", "done_flagged", "stale", "drift", "orphaned", "superseded"].includes(st)) {
    if (snap.sourceSha256 !== d.sha256) return { class: "stale", reason: "source changed since the recorded translation", edited };
    if (!hasFile) return { class: "missing", reason: "recorded as translated but the translation file is gone", edited: false };
    if (st === "drift") return { class: "drift", reason: "glossary preferred term changed after this translation", edited };
    if (edited) return { class: "edited", reason: "translation file differs from the recorded hash (edited outside a run)", edited: true };
    return { class: "fresh", reason: "", edited: false };
  }
  return { class: "new", reason: `unrecognised recorded status "${st}"`, edited };
}

/** Terms whose preferred translation changed since this document was translated and whose old wording is still in the text. */
function driftOf(snap, glossaryData, translationFile) {
  if (!snap?.termTargets || !glossaryData?.terms) return [];
  let text;
  try {
    text = readFileSync(translationFile, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const [id, old] of Object.entries(snap.termTargets)) {
    const t = glossaryData.terms.find((x) => x.id === id);
    if (t?.target && t.target !== old && text.includes(old)) out.push({ id, old, new: t.target });
  }
  return out;
}

export function analyse(ctx, locale, options = {}) {
  const paths = localePaths(ctx, locale);
  const found = discover(ctx, locale, options);
  const { snapshot, source: snapshotSource } = loadSnapshot(paths.state);
  const glossary = glossaryInfo(paths, snapshot);
  // a document whose last ledger event is `doc_start`, with no run active, was abandoned mid-way
  const tail = lockHeld(paths.state) ? new Map() : ledgerTail(paths.state);
  const docs = {};
  for (const d of found.docs) {
    const snap = snapshot.docs[d.doc];
    const translationPath = contentPath(ctx, locale, d.doc);
    const diskSha = fileSha(translationPath);
    let c = classify(d, snap, diskSha);
    let driftTerms = [];
    if (c.class === "fresh" || c.class === "edited") {
      driftTerms = driftOf(snap, glossary.data, translationPath);
      if (driftTerms.length) c = { ...c, class: "drift", reason: `preferred term changed: ${driftTerms.map((t) => `${t.id}: ${t.old} → ${t.new}`).join("; ")}` };
    }
    if (["new", "stale", "drift", "failed", "missing"].includes(c.class) && tail.get(d.doc)?.event === "doc_start") {
      const attempts = (snap?.attempts ?? 0) + tail.get(d.doc).starts;
      c = attempts >= 3
        ? { ...c, class: "blocked", reason: `run ${tail.get(d.doc).run} started this document ${attempts} times without finishing; reset attempts to 0 in snapshot.json to retry` }
        : { ...c, class: "interrupted", reason: `run ${tail.get(d.doc).run} started this document but never finished it` };
    }
    docs[d.doc] = {
      doc: d.doc, ...c, bytes: d.bytes, sourceSha256: d.sha256, external: d.external,
      tier: tierOf(d.doc, ctx.profile.priority), attempts: (snap?.attempts ?? 0) + (c.class === "interrupted" ? tail.get(d.doc).starts : 0), status: snap?.status ?? null,
      flagged: snap?.status === "done_flagged" || (snap?.flags?.length ?? 0) > 0, flags: snap?.flags ?? [], abs: d.abs,
      translationPath, translationExists: diskSha !== null,
      adopted: Boolean(snap?.adopted), driftTerms,
      incremental: c.class === "stale" && existsSync(baseSourcePath(paths.state, d.doc)),
    };
  }
  const orphans = Object.keys(snapshot.docs).filter((doc) => !docs[doc]).sort();
  for (const doc of orphans) docs[doc] = { doc, class: "orphan", reason: "recorded in the state but no longer discovered in the source", edited: false, bytes: 0, tier: 3, attempts: snapshot.docs[doc].attempts ?? 0, status: snapshot.docs[doc].status ?? null, flagged: false, flags: [], external: false, abs: null };
  return { locale, paths, docs, snapshot, snapshotSource, glossary, budgets: ctx.profile.budgets ?? {}, sourceRevision: found.sourceRevision, sourceRoot: found.sourceRoot, via: found.via };
}

// ---------------------------------------------------------------------------------------------- planning & figures

export function summarise(docs) {
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const d of Object.values(docs)) counts[d.class] += 1;
  const translatable = Object.values(docs).filter((d) => d.class !== "orphan" && !d.external).length;
  const covered = counts.fresh + counts.edited;
  const adopted = Object.values(docs).filter((d) => ["fresh", "edited"].includes(d.class) && d.adopted).length;
  return { counts, translatable, covered, adopted, coverage: translatable ? covered / translatable : 1, flagged: Object.values(docs).filter((d) => ["fresh", "edited"].includes(d.class) && d.flagged).length };
}

export function plan(analysis, { maxDocs, maxBytes } = {}) {
  const budgets = analysis.budgets ?? {};
  const limitDocs = maxDocs ?? budgets.maxDocs ?? Infinity;
  const limitBytes = maxBytes ?? budgets.maxSourceBytes ?? Infinity;
  const pending = Object.values(analysis.docs)
    .filter((d) => d.class in PENDING_RANK)
    .sort((a, b) => PENDING_RANK[a.class] - PENDING_RANK[b.class] || a.tier - b.tier || a.bytes - b.bytes || a.doc.localeCompare(b.doc));
  const picked = [];
  let bytes = 0;
  for (const d of pending) {
    if (picked.length >= limitDocs) break;
    if (picked.length > 0 && bytes + d.bytes > limitBytes) break; // a single oversize document is still allowed on its own
    picked.push(d);
    bytes += d.bytes;
  }
  return { pending, picked, pickedBytes: bytes, limits: { maxDocs: Number.isFinite(limitDocs) ? limitDocs : null, maxSourceBytes: Number.isFinite(limitBytes) ? limitBytes : null } };
}

/** Coverage per directory prefix (`depth` path segments of the document path, the file name excluded). */
export function breakdown(docs, depth = 2) {
  const groups = new Map();
  for (const d of Object.values(docs)) {
    if (d.class === "orphan" || d.external) continue;
    const parts = d.doc.split("/").slice(0, -1).slice(0, depth);
    const key = parts.length ? parts.join("/") : ".";
    const g = groups.get(key) ?? { group: key, total: 0, covered: 0, pending: 0, other: 0 };
    g.total += 1;
    if (d.class === "fresh" || d.class === "edited") g.covered += 1;
    else if (d.class in PENDING_RANK) g.pending += 1;
    else g.other += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
}

/** Cost and quality figures recorded by `finalize`, grouped by model. */
export function usageByModel(snapshot) {
  const out = {};
  for (const e of Object.values(snapshot.docs ?? {})) {
    if (!e.model) continue;
    const m = (out[e.model] ??= { docs: 0, retries: 0, tokensIn: 0, tokensOut: 0, seconds: 0, flagged: 0 });
    m.docs += 1;
    m.retries += e.retries ?? 0;
    m.tokensIn += e.tokens?.in ?? 0;
    m.tokensOut += e.tokens?.out ?? 0;
    m.seconds += e.seconds ?? 0;
    if (e.status === "done_flagged") m.flagged += 1;
  }
  return out;
}
