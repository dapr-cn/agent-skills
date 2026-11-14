import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { libUrl, makeSite, write, doc } from "./helpers.mjs";

const core = await import(libUrl("core.mjs"));
const { classify, plan, summarise, breakdown, usageByModel, globMatcher, contentPath, pickLocales, loadProfile } = core;

const d = (over = {}) => ({ doc: "a.md", sha256: "S1", external: false, ...over });

test("classify: every class from the state-and-recovery table", () => {
  const snap = (over) => ({ status: "done", sourceSha256: "S1", translationSha256: "T1", attempts: 1, ...over });
  const cases = [
    ["external, no translation", d({ external: true }), undefined, null, "external"],
    ["external with a local file", d({ external: true }), undefined, "T1", "superseded"],
    ["external with a record", d({ external: true }), snap(), null, "superseded"],
    ["nothing at all", d(), undefined, null, "new"],
    ["file without record", d(), undefined, "T1", "untracked"],
    ["done and unchanged", d(), snap(), "T1", "fresh"],
    ["done_flagged unchanged", d(), snap({ status: "done_flagged" }), "T1", "fresh"],
    ["source changed", d({ sha256: "S2" }), snap(), "T1", "stale"],
    ["file hand-edited", d(), snap(), "TX", "edited"],
    ["file gone", d(), snap(), null, "missing"],
    ["persisted drift", d(), snap({ status: "drift" }), "T1", "drift"],
    ["failed once", d(), snap({ status: "failed" }), null, "failed"],
    ["failed three times", d(), snap({ status: "failed", attempts: 3 }), null, "blocked"],
    ["blocked", d(), snap({ status: "blocked" }), null, "blocked"],
    ["interrupted", d(), snap({ status: "interrupted", attempts: 1 }), null, "interrupted"],
    ["interrupted three times", d(), snap({ status: "interrupted", attempts: 3 }), null, "blocked"],
    ["unknown status", d(), snap({ status: "weird" }), "T1", "new"],
  ];
  for (const [name, doc_, s, disk, expected] of cases) assert.equal(classify(doc_, s, disk).class, expected, name);
});

test("classify: stale + hand edits is reported with edited=true so a human decides", () => {
  const r = classify(d({ sha256: "S2" }), { status: "done", sourceSha256: "S1", translationSha256: "T1" }, "TX");
  assert.equal(r.class, "stale");
  assert.equal(r.edited, true);
});

const mk = (doc_, cls, bytes, tier = 3, extra = {}) => ({ doc: doc_, class: cls, bytes, tier, external: false, ...extra });
const analysisOf = (list, budgets = {}) => ({ docs: Object.fromEntries(list.map((x) => [x.doc, x])), budgets });

test("plan: interrupted/stale first, then drift, then new/failed/missing; blocked and fresh never", () => {
  const a = analysisOf([
    mk("new.md", "new", 10), mk("drift.md", "drift", 10), mk("stale.md", "stale", 10), mk("int.md", "interrupted", 10),
    mk("failed.md", "failed", 10), mk("missing.md", "missing", 10), mk("blocked.md", "blocked", 10), mk("fresh.md", "fresh", 10),
  ]);
  const { pending } = plan(a);
  assert.deepEqual(pending.slice(0, 2).map((x) => x.class).sort(), ["interrupted", "stale"]);
  assert.equal(pending[2].class, "drift");
  assert.deepEqual(pending.slice(3).map((x) => x.doc).sort(), ["failed.md", "missing.md", "new.md"]);
  assert.equal(pending.some((x) => ["blocked", "fresh"].includes(x.class)), false);
});

test("plan: within a group tier wins, then smaller files first", () => {
  const a = analysisOf([mk("big1.md", "new", 900, 1), mk("small3.md", "new", 5, 3), mk("small1.md", "new", 50, 1), mk("tier2.md", "new", 1, 2)]);
  assert.deepEqual(plan(a).pending.map((x) => x.doc), ["small1.md", "big1.md", "tier2.md", "small3.md"]);
});

test("plan: budgets stop the batch; one oversize document is still allowed alone", () => {
  const a = analysisOf([mk("a.md", "new", 40), mk("b.md", "new", 40), mk("c.md", "new", 40)], { maxDocs: 10, maxSourceBytes: 100 });
  assert.deepEqual(plan(a).picked.map((x) => x.doc), ["a.md", "b.md"]);
  assert.deepEqual(plan(a, { maxDocs: 1 }).picked.map((x) => x.doc), ["a.md"]);
  assert.deepEqual(plan(a, { maxBytes: 10 }).picked.map((x) => x.doc), ["a.md"]);
  assert.equal(plan(a, { maxDocs: 1 }).limits.maxDocs, 1);
});

test("summarise and breakdown: coverage counts fresh + edited over translatable documents", () => {
  const list = [mk("g/a.md", "fresh", 1), mk("g/b.md", "edited", 1), mk("g/c.md", "new", 1), mk("h/x/y.md", "stale", 1), mk("ext.md", "external", 1, 3, { external: true }), mk("gone.md", "orphan", 0)];
  const s = summarise(Object.fromEntries(list.map((x) => [x.doc, x])));
  assert.equal(s.translatable, 4);
  assert.equal(s.covered, 2);
  assert.equal(s.coverage, 0.5);
  assert.equal(summarise({}).coverage, 1, "nothing to translate counts as complete");
  const rows = breakdown(Object.fromEntries(list.map((x) => [x.doc, x])), 1);
  assert.deepEqual(rows.map((r) => [r.group, r.total, r.covered, r.pending]), [["g", 3, 2, 1], ["h", 1, 0, 1]]);
});

test("usageByModel groups cost figures recorded by finalize", () => {
  const u = usageByModel({ docs: {
    a: { model: "haiku", retries: 1, tokens: { in: 100, out: 50 }, seconds: 3, status: "done" },
    b: { model: "haiku", retries: 0, tokens: { in: 10, out: 5 }, seconds: 1, status: "done_flagged" },
    c: { status: "done" },
  } });
  assert.deepEqual(u, { haiku: { docs: 2, retries: 1, tokensIn: 110, tokensOut: 55, seconds: 4, flagged: 1 } });
});

test("globMatcher supports **, *, ? and braces", () => {
  const m = globMatcher(["docs/**/*.md", "*.{md,mdx}", "x?.txt"]);
  for (const ok of ["docs/a.md", "docs/x/y/z.md", "README.mdx", "xa.txt"]) assert.ok(m(ok), ok);
  for (const bad of ["docs/a.txt", "src/docs/a.md", "xab.txt", "a/b.md"]) assert.equal(m(bad), false, bad);
});

test("contentPath: default location, output.template with {locale}/{dir}/{doc}, and refusal to escape the repo", () => {
  const site = makeSite({ locales: ["zh-CN"] });
  const ctx = loadProfile(site.profile);
  assert.equal(contentPath(ctx, "zh-CN", "sub/a.md"), site.content("zh-CN", "sub/a.md"));
  ctx.profile.output = { template: "site/{locale}/{doc}" };
  assert.equal(contentPath(ctx, "zh-CN", "sub/a.md"), path.join(site.repo, "site/zh-CN/sub/a.md"));
  ctx.profile.locales["zh-CN"].dir = "zh";
  ctx.profile.output = { template: "site/{dir}/{doc}" };
  assert.equal(contentPath(ctx, "zh-CN", "a.md"), path.join(site.repo, "site/zh/a.md"));
  ctx.profile.output = { template: "../elsewhere/{doc}" };
  assert.throws(() => contentPath(ctx, "zh-CN", "a.md"), /outside the repository/);
});

test("pickLocales: one locale, the default, or all; unknown locales are rejected", () => {
  const profile = { defaultLocale: "zh-CN", locales: { "zh-CN": {}, "ja-JP": {} } };
  assert.deepEqual(pickLocales(profile), ["zh-CN"]);
  assert.deepEqual(pickLocales(profile, "ja-JP"), ["ja-JP"]);
  assert.deepEqual(pickLocales(profile, "all"), ["zh-CN", "ja-JP"]);
  assert.throws(() => pickLocales(profile, "fr-FR"), /not declared/);
});

test("loadProfile: validates schema, locates the repo from the profile path, and honours --repo", () => {
  const site = makeSite();
  assert.equal(loadProfile(site.profile).repo, site.repo);
  assert.equal(loadProfile(site.profile, { repo: site.repo }).repo, site.repo);
  const bad = write(path.join(site.repo, "other/profile.yaml"), "schema: 2\ntranslationsRoot: t\nlocales: {a: {}}\n");
  assert.throws(() => loadProfile(bad), /schema: 1/);
  const noRoot = write(path.join(site.repo, "other2/profile.yaml"), "schema: 1\nlocales: {a: {}}\n");
  assert.throws(() => loadProfile(noRoot), /translationsRoot/);
  const stray = write(path.join(site.repo, "stray/profile.yaml"), "schema: 1\ntranslationsRoot: t\nlocales: {a: {}}\n");
  assert.throws(() => loadProfile(stray), /cannot locate the repository/);
  assert.throws(() => loadProfile(path.join(site.repo, "nope.yaml")), /not found/);
});

test("discover: glob sources skip the translations root and hash files; duplicates and bad NDJSON are rejected", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "sub/b.md": doc("B"), "skip.txt": "x" } });
  const ctx = loadProfile(site.profile);
  const found = core.discover(ctx, "zh-CN");
  assert.deepEqual(found.docs.map((x) => x.doc), ["a.md", "sub/b.md"]);
  assert.equal(found.docs[0].sha256.length, 64);
  const dup = write(path.join(site.repo, "dup.ndjson"), `${JSON.stringify({ doc: "x.md", sha256: "1" })}\n${JSON.stringify({ doc: "x.md", sha256: "1" })}\n`);
  assert.throws(() => core.discover(ctx, "zh-CN", { discoveryFile: dup }), /twice/);
  const bad = write(path.join(site.repo, "bad.ndjson"), "not json\n");
  assert.throws(() => core.discover(ctx, "zh-CN", { discoveryFile: bad }), /not JSON/);
});

test("discover: --no-exec refuses a discovery command but still allows glob sources", () => {
  const site = makeSite({ sources: { "a.md": doc("A") } });
  const ctx = loadProfile(site.profile);
  assert.equal(core.discover(ctx, "zh-CN", { noExec: true }).docs.length, 1);
  delete ctx.profile.sources.glob;
  ctx.profile.sources.discovery = { cwd: ".", command: "echo hi" };
  assert.throws(() => core.discover(ctx, "zh-CN", { noExec: true }), /no-exec/);
});

test("discover: a failing or timing-out adapter is reported, not swallowed", () => {
  const site = makeSite();
  const ctx = loadProfile(site.profile);
  delete ctx.profile.sources.glob;
  ctx.profile.sources.discovery = { cwd: ".", command: "echo boom >&2; exit 3" };
  assert.throws(() => core.discover(ctx, "zh-CN"), /exited 3[\s\S]*boom/);
  ctx.profile.sources.discovery = { cwd: ".", command: "sleep 5" };
  assert.throws(() => core.discover(ctx, "zh-CN", { timeoutSeconds: 0.2 }), /failed to run|ETIMEDOUT/);
  ctx.profile.sources.discovery = { cwd: ".", command: `printf '%s\\n' '{"_meta":{"sourceRevision":"abc","sourceRoot":"docs"}}' '{"doc":"a.md","bytes":1,"sha256":"1","external":true}'; ` };
  const ok = core.discover(ctx, "zh-CN");
  assert.equal(ok.sourceRevision, "abc");
  assert.equal(ok.docs[0].abs, path.join(site.repo, "docs/a.md"), "_meta.sourceRoot resolves the source file location");
});
