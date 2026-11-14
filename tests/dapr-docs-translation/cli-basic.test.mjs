import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { doc, editProfile, makeSite, read, readJsonFile, statectl, tmpDir, tr, trJson, write } from "./helpers.mjs";
import { parseYaml } from "../../dapr-docs-translation/scripts/lib/yaml.mjs";

test("init: --dry-run writes nothing", () => {
  const repo = tmpDir();
  const r = tr("init", "--repo", repo, "--dry-run", "--source-root", "docs");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would create/);
  assert.equal(existsSync(path.join(repo, "translations")), false);
});

test("init: scaffolds profile, README and one folder set per locale; the profile parses", () => {
  const site = makeSite({ locales: ["zh-CN", "ja-JP"] });
  for (const f of ["translations/profile.yaml", "translations/README.md", "translations/locales/zh-CN/content/.gitkeep", "translations/locales/ja-JP/state/.gitkeep", "translations/locales/ja-JP/glossary/.gitkeep"]) {
    assert.ok(existsSync(path.join(site.repo, f)), f);
  }
  const p = parseYaml(read(site.profile));
  assert.equal(p.schema, 1);
  assert.equal(p.defaultLocale, "zh-CN");
  assert.equal(p.locales["ja-JP"].cjk, true);
  assert.equal(p.sources.glob.root, "docs");
  assert.deepEqual(p.models, { translate: "haiku", review: "haiku", escalate: "sonnet" });
  assert.equal(p.keepBaseSource, true);
});

test("init: never overwrites an existing file", () => {
  const site = makeSite();
  write(site.profile, `${read(site.profile)}# edited\n`);
  const again = tr("init", "--repo", site.repo, "--source-root", "docs");
  assert.equal(again.status, 0);
  assert.match(again.stdout, /exists \(left untouched\)/);
  assert.ok(read(site.profile).endsWith("# edited\n"));
});

test("init: --output-template puts translations in the site tree and widens writeScope", () => {
  const site = makeSite({ initArgs: ["--output-template", "src/content/docs/{locale}/{doc}"] });
  const p = parseYaml(read(site.profile));
  assert.equal(p.output.template, "src/content/docs/{locale}/{doc}");
  assert.ok(p.writeScope.includes("src/content/docs/"));
  assert.equal(existsSync(path.join(site.repo, "translations/locales/zh-CN/content")), false, "no content folder is created for a site-tree layout");
  assert.ok(existsSync(path.join(site.repo, "translations/locales/zh-CN/state/.gitkeep")));
});

test("init: rejects a translations root outside the repo and a missing repo", () => {
  const repo = tmpDir();
  assert.equal(tr("init", "--repo", repo, "--translations-root", "../x").status, 2);
  assert.equal(tr("init", "--repo", path.join(repo, "nope")).status, 2);
  assert.equal(tr("init").status, 2);
});

test("scan: first run — all new, smallest first, budgets apply, one oversize document is allowed alone", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "sub/b.md": doc("B", "Some longer body text here."), "sub/c.md": doc("C", "x".repeat(200)) } });
  let s = trJson("scan", "--profile", site.profile);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.json.summary.new, 3);
  assert.equal(s.json.snapshotSource, "none");
  assert.deepEqual(s.json.pending.map((p) => p.doc), ["a.md", "sub/b.md", "sub/c.md"]);
  s = trJson("scan", "--profile", site.profile, "--max-docs", "2");
  assert.equal(s.json.picked.length, 2);
  assert.equal(s.json.pending.length, 3);
  s = trJson("scan", "--profile", site.profile, "--max-bytes", "10");
  assert.equal(s.json.picked.length, 1);
});

test("scan: priority tiers from the profile order the batch", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "guides/z.md": doc("Z", "x".repeat(300)), "ref/r.md": doc("R") } });
  editProfile(site, (t) => t.replace("priority: []", 'priority:\n  - { tier: 1, match: ["guides/"] }\n  - { tier: 4, match: ["ref/"] }'));
  const s = trJson("scan", "--profile", site.profile);
  assert.deepEqual(s.json.pending.map((p) => p.doc), ["guides/z.md", "a.md", "ref/r.md"]);
});

test("scan: --out is written outside the translations root only; plain text output lists the plan", () => {
  const site = makeSite({ sources: { "a.md": doc("A") } });
  const bad = tr("scan", "--profile", site.profile, "--out", path.join(site.repo, "translations/plan.json"));
  assert.equal(bad.status, 2);
  assert.equal(existsSync(path.join(site.repo, "translations/plan.json")), false);
  const out = path.join(tmpDir(), "plan.json");
  const ok = tr("scan", "--profile", site.profile, "--out", out);
  assert.equal(ok.status, 0);
  assert.equal(readJsonFile(out).locale, "zh-CN");
  assert.match(ok.stdout, /work plan: 1 picked of 1 pending/);
  assert.match(ok.stdout, /\* new\s+t3/);
});

test("scan: reports external and superseded documents from a saved discovery file", () => {
  const site = makeSite({ sources: { "a.md": doc("A") } });
  write(site.content("zh-CN", "a.md"), "local\n");
  const nd = write(path.join(tmpDir(), "d.ndjson"), [
    JSON.stringify({ _meta: { sourceRevision: "rev1" } }),
    JSON.stringify({ doc: "x.md", bytes: 5, sha256: "1".repeat(64), external: true }),
    JSON.stringify({ doc: "a.md", bytes: 5, sha256: "2".repeat(64), external: true }),
    JSON.stringify({ doc: "y.md", bytes: 5, sha256: "3".repeat(64), external: false }),
  ].join("\n"));
  const s = trJson("scan", "--profile", site.profile, "--discovery-file", nd);
  assert.deepEqual([s.json.summary.external, s.json.summary.superseded, s.json.summary.new, s.json.sourceRevision], [1, 1, 1, "rev1"]);
});

test("scan: --no-exec refuses a profile that would run a discovery command", () => {
  const site = makeSite();
  editProfile(site, (t) => t.replace(/sources:[\s\S]*?\n\n/, 'sources:\n  description: x\n  discovery: { cwd: ".", command: "echo should-not-run > ran.txt" }\n\n'));
  const r = tr("scan", "--profile", site.profile, "--no-exec");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no-exec/);
  assert.equal(existsSync(path.join(site.repo, "ran.txt")), false, "the command never ran");
});

test("scan/status: bad input exits 2", () => {
  const site = makeSite();
  assert.equal(tr("scan").status, 2);
  assert.equal(tr("scan", "--profile", site.profile, "--locale", "fr-FR").status, 2);
  assert.equal(tr("scan", "--profile", path.join(site.repo, "none.yaml")).status, 2);
  assert.equal(tr("bogus").status, 2);
  assert.equal(tr().status, 2);
  assert.equal(tr("scan", "--profile").status, 2);
});

test("--locale all: scan and status cover every declared locale; writing commands refuse it", () => {
  const site = makeSite({ locales: ["zh-CN", "ja-JP"], sources: { "a.md": doc("A"), "b.md": doc("B") } });
  write(site.content("ja-JP", "a.md"), "日本語\n");
  const s = trJson("scan", "--profile", site.profile, "--locale", "all");
  assert.deepEqual(Object.keys(s.json.locales), ["zh-CN", "ja-JP"]);
  assert.equal(s.json.locales["zh-CN"].summary.new, 2);
  assert.equal(s.json.locales["ja-JP"].summary.untracked, 1);
  const text = tr("status", "--profile", site.profile, "--locale", "all");
  assert.equal(text.status, 0);
  assert.match(text.stdout, /zh-CN\s+0\.0%/);
  assert.match(text.stdout, /ja-JP\s+0\.0%/);
  const gated = tr("status", "--profile", site.profile, "--locale", "all", "--fail-under", "50");
  assert.equal(gated.status, 1);
  assert.match(gated.stdout, /GATE FAILED \(zh-CN\)/);
  assert.equal(tr("adopt", "--profile", site.profile, "--locale", "all").status, 2);
  assert.equal(tr("next", "--profile", site.profile, "--locale", "all", "--out-dir", tmpDir()).status, 2);
});

test("status: coverage gates, class gates, unknown classes, JSON shape", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "sub/b.md": doc("B") } });
  const s = trJson("status", "--profile", site.profile);
  assert.equal(s.status, 0);
  assert.equal(s.json.summary.coverage, 0);
  assert.deepEqual(s.json.breakdown.map((r) => r.group), [".", "sub"]);
  assert.equal(trJson("status", "--profile", site.profile, "--fail-under", "10").status, 1);
  assert.equal(trJson("status", "--profile", site.profile, "--fail-under", "0").status, 0);
  assert.equal(trJson("status", "--profile", site.profile, "--fail-on", "new").status, 1);
  assert.equal(trJson("status", "--profile", site.profile, "--fail-on", "stale,failed").status, 0);
  assert.equal(trJson("status", "--profile", site.profile, "--fail-on", "bogus").status, 2);
});

test("scan: a corrupt snapshot falls back to a backup and says so", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "b.md": doc("B") } });
  const stateDir = site.state("zh-CN");
  // two finalizes give two snapshot generations, so a backup exists
  for (const rel of ["a.md", "b.md"]) {
    write(site.content("zh-CN", rel), doc("乙", "中文。"));
    const f = statectl("doc", "finalize", "--dir", stateDir, "--run", "r1", "--doc", rel, "--source", path.join(site.repo, "docs", rel), "--translation", site.content("zh-CN", rel), "--repo", site.repo);
    assert.equal(f.status, 0, f.stderr);
  }
  write(path.join(stateDir, "snapshot.json"), "{ corrupt");
  const s = trJson("scan", "--profile", site.profile);
  assert.equal(s.status, 0);
  assert.match(s.json.snapshotSource, /^backup:/);
});
