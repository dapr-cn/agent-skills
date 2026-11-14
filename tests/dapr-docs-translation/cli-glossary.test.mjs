import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { doc, editProfile, makeSite, read, readJsonFile, sha, statectl, tmpDir, tr, trJson, write } from "./helpers.mjs";

const glossaryFile = (site) => path.join(site.glossaryDir("zh-CN"), "glossary.json");
const pendingFile = (site) => path.join(site.glossaryDir("zh-CN"), "pending.json");
const ledger = (site) => read(path.join(site.state("zh-CN"), "ledger.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
const changes = (site) => read(path.join(site.glossaryDir("zh-CN"), "changes.jsonl")).trim().split("\n").map((l) => JSON.parse(l));

// ------------------------------------------------------------------------------------------------ audit

const AUTO = (id, source, target, extra = {}) => ({ id, source, target, alt: [], note: "", origin: "auto", locked: false, confidence: "medium", occurrences: 1, conflicts: [], ...extra });

/** a site with two finished translations and a glossary that was filled without the quality gate */
function auditSite() {
  const site = makeSite({ sources: {
    "a.md": doc("A", "The relay and the router. Open the file."),
    "b.md": doc("B", "Another router here."),
    "c.md": doc("C", "A relay again."),
  } });
  write(glossaryFile(site), `${JSON.stringify({
    schema: 1, version: 5, updatedAt: null,
    doNotTranslate: [{ term: "OmniRoute", note: "", origin: "bootstrap", locked: false }],
    terms: [
      AUTO("router", "router", "路由器"), AUTO("relay", "relay", "中继"),
      AUTO("file", "file", "文件", { origin: "bootstrap" }),
      AUTO("sentinel", "sentinel", "哨兵", { origin: "human" }),
    ],
  }, null, 2)}\n`);
  for (const [rel, zh] of [["a.md", doc("甲", "中继和路由器。打开文件。")], ["b.md", doc("乙", "另一个路由器。")]]) {
    write(site.content("zh-CN", rel), zh);
    const f = statectl("doc", "finalize", "--dir", site.state("zh-CN"), "--run", "r1", "--doc", rel, "--source", path.join(site.repo, "docs", rel), "--translation", site.content("zh-CN", rel), "--repo", site.repo);
    assert.equal(f.status, 0, f.stderr);
  }
  return site;
}

test("glossary audit: a dry run reports what would be removed and demoted, and changes nothing", () => {
  const site = auditSite();
  const before = sha(glossaryFile(site));
  const r = trJson("glossary", "audit", "--profile", site.profile);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.terms, r.json.keep, r.json.applied], [4, 2, false]);
  assert.deepEqual(r.json.remove.map((x) => [x.id, x.reason.split(":")[0]]), [["file", "generic"]]);
  assert.deepEqual(r.json.demote.map((x) => [x.id, x.usedIn]), [["relay", 1]]);
  assert.equal(sha(glossaryFile(site)), before);
  assert.equal(existsSync(pendingFile(site)), false);
  assert.match(tr("glossary", "audit", "--profile", site.profile).stdout, /dry run: nothing changed \(use --apply\)/);
});

test("glossary audit --apply: removes non-terms, sends under-evidenced ones back to pending, keeps human entries, and the log and snapshot stay in step", () => {
  const site = auditSite();
  const r = trJson("glossary", "audit", "--profile", site.profile, "--apply", "--run", "audit1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.applied, r.json.version], [true, 6]);
  const g = readJsonFile(glossaryFile(site));
  assert.deepEqual(g.terms.map((t) => t.id), ["router", "sentinel"]);
  assert.equal(g.version, 6);
  assert.deepEqual(g.doNotTranslate.map((n) => n.term), ["OmniRoute"], "a CamelCase product name survives the audit");
  const pending = readJsonFile(pendingFile(site));
  assert.deepEqual(pending.entries.map((e) => [e.id, e.target, e.docs]), [["relay", "中继", ["a.md"]]]);
  assert.deepEqual(changes(site).map((c) => [c.op, c.id, c.to]), [["demote", "file", "removed"], ["demote", "relay", "pending"]]);
  assert.ok(ledger(site).some((e) => e.event === "glossary_change" && e.run === "audit1" && /^audit:/.test(e.note)));
  assert.equal(readJsonFile(path.join(site.state("zh-CN"), "snapshot.json")).glossaryVersion, 6);
  const scan = trJson("scan", "--profile", site.profile).json;
  assert.deepEqual([scan.glossary.changedOutsideRun, scan.glossary.pending], [false, 1]);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "run.lock")), false);
  // a second audit has nothing left to do
  const again = trJson("glossary", "audit", "--profile", site.profile, "--apply");
  assert.deepEqual([again.json.remove.length, again.json.demote.length, again.json.applied], [0, 0, false]);
});

test("glossary audit: a demoted term comes back when another document uses the same rendering (the loop closes by itself)", () => {
  const site = auditSite();
  trJson("glossary", "audit", "--profile", site.profile, "--apply");
  const out = tmpDir("dt-jobs-");
  const next = trJson("next", "--profile", site.profile, "--out-dir", out, "--doc", "c.md", "--run", "main");
  const job = readJsonFile(next.json.jobs[0].job);
  assert.deepEqual(job.glossary.pending, [{ source: "relay", target: "中继", kind: "term", seenIn: 1 }], "the demoted term is offered as a suggestion");
  write(job.output.draft, doc("丙", "又是中继。"));
  const fin = trJson("finalize", "--profile", site.profile, "--job", next.json.jobs[0].job, "--run", "main");
  assert.equal(fin.status, 0, fin.stderr);
  assert.equal(fin.json.glossary.promoted, 1);
  assert.deepEqual(readJsonFile(glossaryFile(site)).terms.map((t) => t.id), ["relay", "router", "sentinel"]);
  assert.deepEqual(readJsonFile(pendingFile(site)).entries, []);
});

test("glossary audit: refuses to judge by evidence when there is none; --static-only applies just the screening rules", () => {
  const site = makeSite({ sources: { "a.md": doc("A", "The file.") } });
  write(glossaryFile(site), `${JSON.stringify({ schema: 1, version: 2, doNotTranslate: [], terms: [AUTO("file", "file", "文件", { origin: "bootstrap" }), AUTO("relay", "relay", "中继")] })}\n`);
  assert.equal(tr("glossary", "audit", "--profile", site.profile).status, 2, "no finished translation: every auto term would look unsupported");
  const r = trJson("glossary", "audit", "--profile", site.profile, "--static-only", "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJsonFile(glossaryFile(site)).terms.map((t) => t.id), ["relay"], "only the generic word was removed");
  assert.equal(tr("glossary", "audit", "--profile", makeSite().profile).status, 2, "no glossary at all");
});

// ------------------------------------------------------------------------------------------------ hygiene hints in scan / status

const hintsOf = (site, ...args) => trJson("scan", "--profile", site.profile, ...args).json.glossary.hints;
const textOf = (cmd, site, ...args) => tr(cmd, "--profile", site.profile, ...args).stdout;

test("scan and status say so when the glossary needs attention, name the counts, and print the command to run", () => {
  const site = auditSite();
  const h = hintsOf(site);
  assert.deepEqual([h.remove, h.demote, h.collisions, h.total, h.evidenceJudged, h.documents], [1, 1, 0, 2, true, 2]);
  for (const cmd of ["scan", "status"]) {
    const out = textOf(cmd, site);
    assert.match(out, /glossary {2}needs attention: 1 entry was never a term, 1 lacks evidence in the finished translations/, cmd);
    assert.match(out, /→ node .*tr\.mjs glossary audit --profile .*profile\.yaml/);
  }
  assert.equal(trJson("status", "--profile", site.profile).json.glossary.hints.total, 2);
  assert.match(textOf("scan", site, "--source-root", "docs"), /glossary audit --profile .* --source-root docs/, "the suggested command carries the user's --source-root");
});

test("the hint goes away once the glossary is audited, and stays quiet for a clean glossary", () => {
  const site = auditSite();
  trJson("glossary", "audit", "--profile", site.profile, "--apply");
  assert.equal(hintsOf(site).total, 0);
  for (const cmd of ["scan", "status"]) assert.doesNotMatch(textOf(cmd, site), /needs attention/);
  const none = makeSite({ sources: { "a.md": doc("A") } });
  assert.equal(hintsOf(none), null, "no glossary, nothing to say");
  assert.doesNotMatch(textOf("scan", none), /glossary {2}needs/);
});

test("--no-hints skips the check entirely", () => {
  const site = auditSite();
  assert.equal(hintsOf(site, "--no-hints"), null);
  assert.doesNotMatch(textOf("scan", site, "--no-hints"), /needs attention/);
});

test("when the source files cannot be found only the static findings are reported, with an explanation", () => {
  const site = auditSite();
  const nd = write(path.join(tmpDir(), "d.ndjson"), ["a.md", "b.md", "c.md"].map((rel) => JSON.stringify({ doc: rel, bytes: 1, sha256: sha(path.join(site.repo, "docs", rel)), external: false })).join("\n"));
  const h = hintsOf(site, "--discovery-file", nd);
  assert.deepEqual([h.remove, h.demote, h.evidenceJudged, h.evidenceSkipped], [1, 0, false, true], "no evidence → nothing is demoted, only the generic word is flagged");
  assert.match(textOf("scan", site, "--discovery-file", nd), /needs attention: 1 entry was never a term; evidence was not checked because the source file location is unknown/);
  // a glossary with nothing static to report stays quiet even though evidence could not be judged
  trJson("glossary", "audit", "--profile", site.profile, "--apply");
  const quiet = hintsOf(site, "--discovery-file", nd);
  assert.deepEqual([quiet.total, quiet.evidenceSkipped], [0, true]);
  assert.doesNotMatch(textOf("scan", site, "--discovery-file", nd), /needs attention/);
});

test("two terms sharing one rendering are reported as a collision hint", () => {
  const site = makeSite({ sources: { "a.md": doc("A", "The agent and the proxy.") } });
  write(glossaryFile(site), `${JSON.stringify({ schema: 1, version: 3, doNotTranslate: [], terms: [AUTO("agent", "agent", "代理", { origin: "human" }), AUTO("proxy", "proxy", "代理", { origin: "human" })] })}\n`);
  const h = hintsOf(site);
  assert.deepEqual([h.collisions, h.remove, h.demote, h.total], [1, 0, 0, 1]);
  assert.match(textOf("scan", site), /1 rendering is shared by two source terms/);
});

test("status --fail-on glossary is a CI gate on the hints; other gates keep working next to it", () => {
  const site = auditSite();
  const bad = tr("status", "--profile", site.profile, "--fail-on", "glossary");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /GATE FAILED: the glossary needs attention \(1 never terms, 1 lack evidence, 0 shared renderings\)/);
  assert.equal(tr("status", "--profile", site.profile, "--fail-on", "stale,glossary").status, 1);
  assert.equal(tr("status", "--profile", site.profile, "--fail-on", "stale").status, 0, "without the glossary gate the same repo passes");
  trJson("glossary", "audit", "--profile", site.profile, "--apply");
  assert.equal(tr("status", "--profile", site.profile, "--fail-on", "glossary").status, 0);
  assert.equal(tr("status", "--profile", makeSite().profile, "--fail-on", "glossary").status, 0, "no glossary: nothing to gate");
  assert.equal(tr("status", "--profile", site.profile, "--fail-on", "bogus").status, 2);
});

test("scan --locale all reports hints per locale", () => {
  const site = makeSite({ locales: ["zh-CN", "ja-JP"], sources: { "a.md": doc("A", "The file.") } });
  write(glossaryFile(site), `${JSON.stringify({ schema: 1, version: 1, doNotTranslate: [], terms: [AUTO("file", "file", "文件", { origin: "bootstrap" })] })}\n`);
  const r = trJson("scan", "--profile", site.profile, "--locale", "all").json.locales;
  assert.equal(r["zh-CN"].glossary.hints.remove, 1);
  assert.equal(r["ja-JP"].glossary.hints, null, "the other locale has no glossary");
});

// ------------------------------------------------------------------------------------------------ bootstrap

const EN = (extra = "") => `# Guide\n\n## Providers\n\n| Term | Meaning |\n| --- | --- |\n| Router | picks one |\n| OpenAI | a vendor |\n\n**Fallback** is used.\n${extra}`;
const ZH = (extra = "") => `# 指南\n\n## 提供者\n\n| 术语 | 含义 |\n| --- | --- |\n| 路由器 | 选一个 |\n| OpenAI | 一个供应商 |\n\n**回退** 会被使用。\n${extra}`;

function bootstrapSite() {
  const site = makeSite({ sources: { "a.md": EN(), "b.md": EN(), "c.md": "# C\n\n## Providers\n\n| Term | Meaning |\n| --- | --- |\n| Gateway | a door |\n" } });
  editProfile(site, (t) => t.replace("evidence: []", 'evidence: ["ext/{locale}/"]').replace("doNotTranslateSeeds: []", "doNotTranslateSeeds: [HagiCode]"));
  write(path.join(site.repo, "ext/zh-CN/a.md"), ZH());
  write(path.join(site.repo, "ext/zh-CN/b.md"), ZH());
  write(path.join(site.repo, "ext/zh-CN/c.md"), "# C\n\n## 提供者\n\n| 术语 | 含义 |\n| --- | --- |\n| 网关 | 一扇门 |\n");
  return site;
}

test("glossary bootstrap: a dry run lists what at least two documents agree on, and writes nothing", () => {
  const site = bootstrapSite();
  const r = trJson("glossary", "bootstrap", "--profile", site.profile);
  assert.equal(r.status, 0, r.stderr);
  const pairs = Object.fromEntries(r.json.terms.map((t) => [t.source, [t.target, t.docs]]));
  assert.deepEqual(pairs.Providers, ["提供者", 3]);
  assert.deepEqual(pairs.Router, ["路由器", 2]);
  assert.deepEqual(pairs.Fallback, ["回退", 2]);
  assert.equal(pairs.Gateway, undefined, "one document is not enough");
  assert.deepEqual(r.json.doNotTranslate.map((n) => n.term).sort(), ["HagiCode", "OpenAI"], "a name kept verbatim in two documents, plus the profile seed");
  assert.deepEqual(r.json.documents.find((d) => d.doc === "a.md").aligned, ["headings", "tables", "bold"]);
  assert.equal(r.json.applied, false);
  assert.equal(existsSync(glossaryFile(site)), false);
  assert.match(tr("glossary", "bootstrap", "--profile", site.profile).stdout, /dry run: nothing written/);
});

test("glossary bootstrap --apply creates glossary v1, the starter style notes, the log and the ledger entry", () => {
  const site = bootstrapSite();
  const r = trJson("glossary", "bootstrap", "--profile", site.profile, "--apply", "--run", "boot1");
  assert.equal(r.status, 0, r.stderr);
  const g = readJsonFile(glossaryFile(site));
  assert.equal(g.version, 1);
  const router = g.terms.find((t) => t.id === "router");
  assert.deepEqual([router.target, router.origin, router.confidence, router.occurrences], ["路由器", "bootstrap", "medium", 2]);
  assert.deepEqual(g.doNotTranslate.map((n) => [n.term, n.origin]).sort(), [["HagiCode", "bootstrap"], ["OpenAI", "bootstrap"]]);
  assert.match(read(path.join(site.glossaryDir("zh-CN"), "style.md")), /全角标点/);
  assert.ok(changes(site).some((c) => c.op === "add" && c.id === "router" && c.origin === "bootstrap"));
  assert.ok(ledger(site).some((e) => e.event === "glossary_change" && e.version === 1 && /^bootstrap:/.test(e.note)));
  assert.equal(readJsonFile(path.join(site.state("zh-CN"), "snapshot.json")).glossaryVersion, 1);
  assert.equal(trJson("scan", "--profile", site.profile).json.glossary.changedOutsideRun, false);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "run.lock")), false);
});

test("glossary bootstrap never overwrites a glossary; --merge adds only what is missing and leaves existing renderings alone", () => {
  const site = bootstrapSite();
  assert.equal(tr("glossary", "bootstrap", "--profile", site.profile, "--apply").status, 0);
  assert.equal(tr("glossary", "bootstrap", "--profile", site.profile, "--apply").status, 2, "refused: glossary.json exists");
  // a human changes a rendering and a new pair appears in two more documents
  const g = readJsonFile(glossaryFile(site));
  g.terms.find((t) => t.id === "router").target = "路由";
  write(glossaryFile(site), `${JSON.stringify(g, null, 2)}\n`);
  for (const n of ["d.md", "e.md"]) {
    site.src(n, "# D\n\n## Providers\n\n| Term | Meaning |\n| --- | --- |\n| Router | picks one |\n| Quota | a limit |\n");
    write(path.join(site.repo, "ext/zh-CN", n), "# D\n\n## 提供者\n\n| 术语 | 含义 |\n| --- | --- |\n| 路由器 | 选一个 |\n| 配额 | 一个限制 |\n");
  }
  const r = trJson("glossary", "bootstrap", "--profile", site.profile, "--apply", "--merge");
  assert.equal(r.status, 0, r.stderr);
  const after = readJsonFile(glossaryFile(site));
  assert.equal(after.terms.find((t) => t.id === "router").target, "路由", "the existing rendering is untouched");
  assert.ok(after.terms.find((t) => t.id === "router").conflicts.some((c) => c.target === "路由器"), "the disagreement is recorded for a human");
  assert.equal(after.terms.find((t) => t.id === "quota")?.target, "配额", "a new pair is added");
});

test("glossary bootstrap: clear errors without evidence, without a matching translation, and without a source location", () => {
  const none = makeSite({ sources: { "a.md": EN() } });
  assert.equal(tr("glossary", "bootstrap", "--profile", none.profile).status, 2, "the profile lists no evidence directory");
  const nomatch = makeSite({ sources: { "a.md": EN() } });
  editProfile(nomatch, (t) => t.replace("evidence: []", 'evidence: ["ext/{locale}/"]'));
  write(path.join(nomatch.repo, "ext/zh-CN/other.md"), ZH());
  const r = tr("glossary", "bootstrap", "--profile", nomatch.profile);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /none of the 1 documents has a translation/);
  assert.equal(tr("glossary", "bogus", "--profile", none.profile).status, 2);
});
