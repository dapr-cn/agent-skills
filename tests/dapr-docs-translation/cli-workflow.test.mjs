import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { doc, editProfile, git, hasDiffTool, makeSite, read, readJsonFile, sha, tmpDir, tr, trJson, write } from "./helpers.mjs";

const classOf = (site, name, locale = "zh-CN") => {
  const s = trJson("scan", "--profile", site.profile, "--locale", locale);
  const hit = [...s.json.pending, ...s.json.attention].find((p) => p.doc === name);
  return { scan: s.json, cls: hit?.class ?? (s.json.summary.fresh ? "fresh-or-other" : "none") };
};
const ledger = (site, locale = "zh-CN") => read(path.join(site.state(locale), "ledger.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
const snapshot = (site, locale = "zh-CN") => readJsonFile(path.join(site.state(locale), "snapshot.json"));
const writeGlossary = (site, data, locale = "zh-CN") => write(path.join(site.glossaryDir(locale), "glossary.json"), `${JSON.stringify(data, null, 2)}\n`);
const GLOSSARY = { schema: 1, version: 2, doNotTranslate: [{ term: "Acme" }], terms: [{ id: "setup", source: "setup", target: "安装", origin: "human" }] };

// a source with a glossary term, a do-not-translate name and a code block
const SRC = doc("A", "Use the setup wizard of Acme.\n\n```bash\necho hi\n```");
const ZH = doc("甲", "使用 Acme 的安装向导。\n\n```bash\necho hi\n```");

// the merge mechanics are tested with immediate admission; the staging gate has its own tests below
const immediate = (site) => {
  editProfile(site, (t) => `${t}\nglossary:\n  promoteAfter: 1\n`);
  return site;
};

const nextJobs = (site, ...extra) => {
  const out = tmpDir("dt-jobs-");
  const r = trJson("next", "--profile", site.profile, "--out-dir", out, ...extra);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { out, manifest: r.json, jobFile: (i = 0) => r.json.jobs[i].job, job: (i = 0) => readJsonFile(r.json.jobs[i].job) };
};

// ------------------------------------------------------------------------------------------------ adopt

test("adopt: existing translations become the baseline (untracked → fresh); dry-run writes nothing; twice is a no-op", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "b.md": doc("B"), "c.md": doc("C") } });
  write(site.content("zh-CN", "a.md"), doc("甲", "你好。"));
  write(site.content("zh-CN", "b.md"), doc("乙", "你好。"));
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.untracked, 2);

  const dry = trJson("adopt", "--profile", site.profile, "--dry-run");
  assert.deepEqual([dry.json.adopt.length, dry.json.dryRun], [2, true]);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "snapshot.json")), false);

  const real = trJson("adopt", "--profile", site.profile);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(real.json.adopt.sort(), ["a.md", "b.md"]);
  const s = trJson("scan", "--profile", site.profile);
  assert.deepEqual([s.json.summary.fresh, s.json.summary.untracked, s.json.summary.new, s.json.summary.adopted], [2, 0, 1, 2]);
  assert.equal(snapshot(site).docs["a.md"].adopted, true);
  assert.ok(ledger(site).some((e) => e.event === "doc_adopted" && e.doc === "a.md"));
  assert.equal(readdirSync(path.dirname(site.state("zh-CN"))).includes("state"), true);
  assert.match(tr("adopt", "--profile", site.profile).stdout, /adopted 0 of 0|nothing untracked/);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "run.lock")), false, "the lock is released");
});

test("adopt: --only limits the files; an adopted document goes stale when its source changes", () => {
  const site = makeSite({ sources: { "keep/a.md": doc("A"), "other/b.md": doc("B") } });
  write(site.content("zh-CN", "keep/a.md"), doc("甲", "你好。"));
  write(site.content("zh-CN", "other/b.md"), doc("乙", "你好。"));
  const r = trJson("adopt", "--profile", site.profile, "--only", "keep/**");
  assert.deepEqual(r.json.adopt, ["keep/a.md"]);
  site.src("keep/a.md", doc("A", "Changed upstream."));
  const s = trJson("scan", "--profile", site.profile);
  assert.equal(s.json.pending.find((p) => p.doc === "keep/a.md").class, "stale");
  assert.equal(s.json.pending.find((p) => p.doc === "keep/a.md").incremental, false, "an adopted baseline has no base copy to diff against");
  assert.equal(s.json.summary.untracked, 1);
});

test("adopt: refuses while another run holds the lock (exit 3)", () => {
  const site = makeSite({ sources: { "a.md": doc("A") } });
  write(site.content("zh-CN", "a.md"), doc("甲", "你好。"));
  write(path.join(site.state("zh-CN"), "run.lock"), JSON.stringify({ run: "other", startedAt: new Date().toISOString() }));
  const r = tr("adopt", "--profile", site.profile);
  assert.equal(r.status, 3);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "snapshot.json")), false);
});

test("adopt --if-translation-newer: only translations at least as new as their source (git history decides)", () => {
  const site = makeSite({ sources: { "old.md": doc("Old"), "newer-src.md": doc("N") } });
  write(site.content("zh-CN", "old.md"), doc("旧", "你好。"));
  write(site.content("zh-CN", "newer-src.md"), doc("新", "你好。"));
  git(site.repo, ["init", "-q"]);
  git(site.repo, ["add", "docs/old.md", "docs/newer-src.md"], "2026-01-01T00:00:00Z");
  git(site.repo, ["commit", "-q", "-m", "sources"], "2026-01-01T00:00:00Z");
  git(site.repo, ["add", "translations/locales/zh-CN/content"], "2026-02-01T00:00:00Z");
  git(site.repo, ["commit", "-q", "-m", "translations"], "2026-02-01T00:00:00Z");
  site.src("newer-src.md", doc("N", "Edited after the translation."));
  git(site.repo, ["add", "docs/newer-src.md"], "2026-03-01T00:00:00Z");
  git(site.repo, ["commit", "-q", "-m", "source edit"], "2026-03-01T00:00:00Z");
  const r = trJson("adopt", "--profile", site.profile, "--if-translation-newer");
  assert.deepEqual(r.json.adopt, ["old.md"]);
  assert.deepEqual(r.json.skipped.map((s) => s.doc), ["newer-src.md"]);
  assert.match(r.json.skipped[0].reason, /older/);
});

test("adopt --if-translation-newer: uncommitted source edits count as newer", () => {
  const site = makeSite({ sources: { "a.md": doc("A") } });
  write(site.content("zh-CN", "a.md"), doc("甲", "你好。"));
  git(site.repo, ["init", "-q"]);
  git(site.repo, ["add", "-A"], "2026-01-01T00:00:00Z");
  git(site.repo, ["commit", "-q", "-m", "all"], "2026-01-01T00:00:00Z");
  site.src("a.md", doc("A", "dirty working tree edit"));
  const r = trJson("adopt", "--profile", site.profile, "--if-translation-newer");
  assert.deepEqual(r.json.adopt, []);
  assert.equal(r.json.skipped.length, 1);
});

// ------------------------------------------------------------------------------------------------ next → finalize

test("next: writes a self-contained job (relevant glossary only, mode, commands) and records doc_start with --run", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B", "Nothing special.") } });
  writeGlossary(site, { ...GLOSSARY, terms: [...GLOSSARY.terms, { id: "unused", source: "unused", target: "未用" }] });
  write(path.join(site.glossaryDir("zh-CN"), "style.md"), "- full-width punctuation\n");
  const { manifest, job } = nextJobs(site, "--run", "r1", "--doc", "a.md");
  assert.equal(manifest.jobs.length, 1);
  const j = job();
  assert.deepEqual([j.doc, j.class, j.mode, j.locale, j.cjk, j.chunks], ["a.md", "new", "translate", "zh-CN", true, null]);
  assert.deepEqual(j.glossary.terms.map((t) => t.id), ["setup"], "only terms that occur in this document");
  assert.deepEqual(j.glossary.doNotTranslate.map((t) => t.term), ["Acme"]);
  assert.deepEqual(j.termTargets, { setup: "安装" });
  assert.match(j.style, /full-width/);
  assert.equal(j.source.sha256, sha(path.join(site.repo, "docs/a.md")));
  assert.deepEqual(j.models, { translate: "haiku", review: "haiku", escalate: "sonnet" });
  assert.match(j.commands.check, /tr\.mjs check --job /);
  assert.equal(j.output.final, site.content("zh-CN", "a.md"));
  assert.ok(j.instructions.some((l) => /DATA/.test(l)));
  assert.deepEqual(ledger(site).map((e) => [e.event, e.doc]), [["doc_start", "a.md"]]);
});

test("next: without --run records nothing; --doc must name a translatable document; the plan picks the batch otherwise", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B") } });
  const { manifest } = nextJobs(site, "--max-docs", "1");
  assert.equal(manifest.jobs.length, 1);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "ledger.jsonl")), false);
  assert.equal(tr("next", "--profile", site.profile, "--out-dir", tmpDir(), "--doc", "nope.md").status, 2);
  assert.equal(tr("next", "--profile", site.profile, "--out-dir", path.join(site.repo, "translations/jobs")).status, 2, "jobs must live outside the translations root");
  assert.equal(tr("next", "--profile", site.profile).status, 2);
});

test("check → finalize: a clean draft is accepted, moved into place, recorded with cost figures and a base copy", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, GLOSSARY);
  const jobs = nextJobs(site, "--run", "r1");
  const j = jobs.job();
  write(j.output.draft, ZH);
  const chk = tr("check", "--job", jobs.jobFile());
  assert.equal(chk.status, 0, chk.stdout);
  write(j.output.result, JSON.stringify({ doc: "a.md", ok: true, model: "haiku", retries: 1, seconds: 12, tokens: { in: 900, out: 400 }, flags: [], termCandidates: [] }));
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 0, fin.stderr + fin.stdout);
  assert.equal(fin.json.status, "done", JSON.stringify(fin.json));
  assert.ok(Array.isArray(fin.json.warnings), "environment notices are reported as warnings, not flags");
  assert.equal(read(site.content("zh-CN", "a.md")), ZH);
  assert.equal(existsSync(j.output.draft), false, "the draft is gone once accepted");
  const e = snapshot(site).docs["a.md"];
  assert.deepEqual([e.model, e.retries, e.tokens.in, e.termTargets.setup, e.glossaryVersion], ["haiku", 1, 900, "安装", 2]);
  assert.equal(e.translationPath, "translations/locales/zh-CN/content/a.md");
  assert.equal(read(path.join(site.state("zh-CN"), "base/a.md")), SRC);
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.fresh, 1);
  const status = trJson("status", "--profile", site.profile);
  assert.deepEqual(status.json.usage, { haiku: { docs: 1, retries: 1, tokensIn: 900, tokensOut: 400, seconds: 12, flagged: 0 } });
  assert.match(tr("status", "--profile", site.profile).stdout, /usage by model:\n\s+haiku\s+1 docs, 1 retries/);
});

test("finalize drops an environment notice that a subagent echoed into its own flags", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  const jobs = nextJobs(site);
  write(jobs.job().output.draft, ZH);
  write(jobs.job().output.result, JSON.stringify({ doc: "a.md", ok: true, flags: ["anchor-check-skipped: github-slugger not resolvable", "review: tone"] }));
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.deepEqual(fin.json.flags.filter((f) => !f.startsWith("glossary")), ["review: tone"]);
});

test("finalize: command-line cost figures win over the subagent's self-report", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  const jobs = nextJobs(site);
  write(jobs.job().output.draft, ZH);
  write(jobs.job().output.result, JSON.stringify({ doc: "a.md", ok: true, model: "haiku", seconds: 1, tokens: { in: 0, out: 0 } }));
  const fin = tr("finalize", "--profile", site.profile, "--job", jobs.jobFile(), "--model", "sonnet", "--seconds", "30", "--tokens-in", "500", "--tokens-out", "100");
  assert.equal(fin.status, 0, fin.stderr);
  const e = snapshot(site).docs["a.md"];
  assert.deepEqual([e.model, e.seconds, e.tokens], ["sonnet", 30, { in: 500, out: 100 }]);
});

test("finalize: soft-check findings and the subagent's own flags make it done_flagged", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, GLOSSARY);
  const jobs = nextJobs(site);
  const j = jobs.job();
  write(j.output.draft, ZH.replace("安装", "设置")); // the glossary term is not used → soft flag
  write(j.output.result, JSON.stringify({ doc: "a.md", ok: true, flags: ["review: tone"] }));
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 0, fin.stderr);
  assert.equal(fin.json.status, "done_flagged");
  assert.ok(fin.json.flags.includes("review: tone"));
  assert.ok(fin.json.flags.some((f) => f.startsWith("glossary:")));
  assert.equal(snapshot(site).docs["a.md"].status, "done_flagged");
});

test("finalize: a draft that fails the hard checks is refused and nothing is written; fail records attempts and blocks at 3", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  const jobs = nextJobs(site, "--run", "r1");
  const j = jobs.job();
  write(j.output.draft, ZH.replace("echo hi", "echo 你好"));
  const chk = tr("check", "--job", jobs.jobFile());
  assert.equal(chk.status, 1);
  assert.ok(JSON.parse(chk.stdout).hard.some((h) => h.check === "code-fence"));
  const fin = tr("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 1);
  assert.equal(existsSync(site.content("zh-CN", "a.md")), false);
  assert.equal(existsSync(j.output.draft), true, "the draft is kept for debugging");
  for (const [n, expected] of [[1, "failed"], [2, "failed"], [3, "blocked"]]) {
    const f = trJson("fail", "--job", jobs.jobFile(), "--reason", `bad draft ${n}`);
    assert.equal(f.json.status, expected);
  }
  const s = trJson("scan", "--profile", site.profile);
  assert.equal(s.json.summary.blocked, 1);
  assert.equal(s.json.picked.length, 0, "a blocked document is not picked");
  assert.equal(tr("check", "--job", jobs.jobFile(), "--file", path.join(site.repo, "missing.md")).status, 2);
});

test("finalize: refuses when the source changed after the job was written", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  const jobs = nextJobs(site);
  write(jobs.job().output.draft, ZH);
  site.src("a.md", doc("A", "changed while translating"));
  const fin = tr("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 2);
  assert.match(fin.stderr, /source changed/);
  assert.equal(existsSync(site.content("zh-CN", "a.md")), false);
});

test("interrupted: a doc_start with no later outcome and no active run is picked up again; an active run protects it; three starts block", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B") } });
  const started = (run) => nextJobs(site, "--run", run, "--doc", "a.md");
  started("r1");
  const during = write(path.join(site.state("zh-CN"), "run.lock"), JSON.stringify({ run: "r1", startedAt: new Date().toISOString() }));
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.interrupted, 0, "a run is active: not abandoned");
  writeFileSync(during, JSON.stringify({ run: "r1", startedAt: new Date(Date.now() - 6 * 3600_000).toISOString() }));
  let s = trJson("scan", "--profile", site.profile);
  assert.equal(s.json.summary.interrupted, 1);
  const a = s.json.pending.find((p) => p.doc === "a.md");
  assert.deepEqual([a.class, a.attempts], ["interrupted", 1]);
  assert.match(a.reason, /r1 started this document/);
  assert.equal(s.json.pending[0].doc, "a.md", "interrupted work comes first");
  started("r2");
  started("r3");
  s = trJson("scan", "--profile", site.profile);
  assert.equal(s.json.summary.blocked, 1, "the third unfinished start blocks the document");
  // an outcome clears it
  const jobs = nextJobs(site, "--run", "r4", "--doc", "b.md");
  write(jobs.job().output.draft, doc("乙", "你好。"));
  assert.equal(tr("finalize", "--profile", site.profile, "--job", jobs.jobFile()).status, 0);
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.fresh, 1);
});

// ------------------------------------------------------------------------------------------------ chunked jobs

const bigSource = () => `---\ntitle: "Big"\n---\n\n# Big\n\n${["One", "Two", "Three", "Four", "Five", "Six"].map((t) => `## ${t}\n\n${"Lorem ipsum dolor sit amet. ".repeat(110)}\n\n`).join("")}`;

test("next --chunk-bytes lowers the chunking threshold and the chunk size", () => {
  const site = makeSite({ sources: { "mid.md": `# T\n\n${["A", "B", "C", "D"].map((t) => `## ${t}\n\n${"Lorem ipsum dolor sit amet. ".repeat(60)}\n\n`).join("")}` } });
  assert.equal(nextJobs(site).job().chunks, null, "about 7 KB: below the default threshold");
  const small = nextJobs(site, "--chunk-bytes", "2048").job();
  assert.ok(small.chunks.length >= 3);
  assert.ok(small.chunks.every((c) => c.bytes <= 2048 + 200));
  assert.equal(small.chunks.map((c) => read(c.src)).join(""), read(path.join(site.repo, "docs/mid.md")));
  assert.equal(tr("next", "--profile", site.profile, "--out-dir", tmpDir(), "--chunk-bytes", "abc").status, 2);
});

test("long documents become chunks; assemble waits for every chunk, joins them and checks the result", () => {
  const site = makeSite({ sources: { "big.md": bigSource() } });
  const jobs = nextJobs(site);
  const j = jobs.job();
  assert.ok(j.chunks.length >= 3, `chunks: ${j.chunks?.length}`);
  assert.equal(jobs.manifest.jobs[0].chunks, j.chunks.length);
  assert.equal(j.chunks.map((c) => read(c.src)).join(""), bigSource(), "chunks reassemble to the source exactly");
  assert.ok(j.instructions.some((l) => /assemble/.test(l)));
  // translate all but the last chunk first → assemble must refuse
  j.chunks.slice(0, -1).forEach((c) => write(c.out, read(c.src).replaceAll("Lorem ipsum dolor sit amet.", "乱数假文。").replace('title: "Big"', 'title: "大"').replace("# Big", "# 大")));
  const early = tr("assemble", "--job", jobs.jobFile());
  assert.equal(early.status, 1);
  assert.match(early.stderr, /missing or empty chunk output/);
  const last = j.chunks.at(-1);
  write(last.out, read(last.src).replaceAll("Lorem ipsum dolor sit amet.", "乱数假文。"));
  const done = tr("assemble", "--job", jobs.jobFile());
  assert.equal(done.status, 0, done.stdout);
  assert.equal(JSON.parse(done.stdout).chunks, j.chunks.length);
  assert.ok(existsSync(j.output.draft));
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 0, fin.stderr + fin.stdout);
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.fresh, 1);
  assert.equal(tr("assemble", "--job", nextJobs(makeSite({ sources: { "s.md": doc("S") } })).jobFile()).status, 2, "assemble needs a chunked job");
});

// ------------------------------------------------------------------------------------------------ stale / incremental / drift

test("stale after finalize is incremental: the job carries the diff between the translated source and the new one", { skip: !hasDiffTool && "diff is not installed" }, () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, GLOSSARY);
  const first = nextJobs(site, "--run", "r1");
  write(first.job().output.draft, ZH);
  assert.equal(tr("finalize", "--profile", site.profile, "--job", first.jobFile()).status, 0);

  site.src("a.md", SRC.replace("wizard", "assistant"));
  const s = trJson("scan", "--profile", site.profile);
  const p = s.json.pending.find((x) => x.doc === "a.md");
  assert.deepEqual([p.class, p.incremental], ["stale", true]);

  const again = nextJobs(site, "--run", "r2");
  const j = again.job();
  assert.equal(j.mode, "incremental");
  assert.equal(j.previous.translation, site.content("zh-CN", "a.md"));
  assert.equal(j.previous.baseSource, path.join(site.state("zh-CN"), "base/a.md"));
  const diff = read(j.previous.diff);
  assert.match(diff, /-Use the setup wizard of Acme\./);
  assert.match(diff, /\+Use the setup assistant of Acme\./);
  // finalizing the update refreshes the base copy
  write(j.output.draft, ZH.replace("向导", "助手"));
  assert.equal(tr("finalize", "--profile", site.profile, "--job", again.jobFile()).status, 0);
  assert.match(read(path.join(site.state("zh-CN"), "base/a.md")), /assistant/);
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.fresh, 1);
});

test("keepBaseSource: false keeps no base copy, so a later change is a full retranslation with the old translation as reference", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  editProfile(site, (t) => t.replace("keepBaseSource: true", "keepBaseSource: false"));
  const first = nextJobs(site);
  write(first.job().output.draft, ZH);
  assert.equal(tr("finalize", "--profile", site.profile, "--job", first.jobFile()).status, 0);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "base/a.md")), false);
  site.src("a.md", SRC.replace("wizard", "assistant"));
  const j = nextJobs(site).job();
  assert.equal(j.mode, "retranslate-with-reference");
  assert.equal(j.previous.diff, null);
});

test("a hand-edited translation whose source also changed is flagged for a human, not silently retranslated", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  const first = nextJobs(site);
  write(first.job().output.draft, ZH);
  assert.equal(tr("finalize", "--profile", site.profile, "--job", first.jobFile()).status, 0);
  write(site.content("zh-CN", "a.md"), `${ZH}\n人工补充。\n`);
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.edited, 1);
  site.src("a.md", doc("A", "changed"));
  const s = trJson("scan", "--profile", site.profile);
  assert.ok(s.json.attention.some((a) => a.doc === "a.md" && a.class === "stale" && a.edited));
  assert.match(tr("scan", "--profile", site.profile).stdout, /overwrite the hand edits/);
});

test("drift: a human changes a preferred term → documents still using the old wording become `drift` with a terms-only job", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B", "Nothing special here.") } });
  writeGlossary(site, GLOSSARY);
  const first = nextJobs(site, "--doc", "a.md");
  write(first.job().output.draft, ZH);
  assert.equal(tr("finalize", "--profile", site.profile, "--job", first.jobFile()).status, 0);
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.drift, 0);

  writeGlossary(site, { ...GLOSSARY, version: 3, terms: [{ ...GLOSSARY.terms[0], target: "设置" }] });
  const s = trJson("scan", "--profile", site.profile);
  assert.equal(s.json.summary.drift, 1);
  assert.equal(s.json.glossary.changedOutsideRun, true);
  const p = s.json.pending.find((x) => x.doc === "a.md");
  assert.equal(p.class, "drift");
  assert.match(p.reason, /setup: 安装 → 设置/);
  assert.equal(s.json.pending.findIndex((x) => x.doc === "a.md") < s.json.pending.findIndex((x) => x.doc === "b.md"), true, "drift outranks new documents");

  const j = nextJobs(site, "--doc", "a.md").job();
  assert.equal(j.mode, "terms-only");
  assert.deepEqual(j.driftTerms, [{ id: "setup", old: "安装", new: "设置" }]);
  assert.deepEqual(j.glossary.terms.map((t) => t.target), ["设置"]);
});

test("drift: a changed term the translation never used is not drift", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, GLOSSARY);
  const first = nextJobs(site);
  write(first.job().output.draft, ZH.replace("安装", "配置"));
  assert.equal(tr("finalize", "--profile", site.profile, "--job", first.jobFile()).status, 0);
  writeGlossary(site, { ...GLOSSARY, terms: [{ ...GLOSSARY.terms[0], target: "设置" }] });
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.drift, 0);
});

// ------------------------------------------------------------------------------------------------ glossary merge

const resultsDir = (site, results) => {
  const jobs = nextJobs(site);
  for (const r of results) {
    const m = jobs.manifest.jobs.find((j) => j.doc === r.doc);
    write(path.join(path.dirname(m.job), "result.json"), JSON.stringify(r));
  }
  return jobs.out;
};

test("glossary merge: folds term candidates in, bumps the version per document, keeps preferred terms, is idempotent", () => {
  const site = immediate(makeSite({ sources: { "a.md": doc("A", "combo and fallback of Acme"), "b.md": doc("B", "Another combo here.") } }));
  writeGlossary(site, { schema: 1, version: 1, doNotTranslate: [], terms: [{ id: "fallback", source: "fallback", target: "回退", origin: "human", locked: true, occurrences: 1, conflicts: [] }] });
  const dir = resultsDir(site, [
    { doc: "a.md", ok: true, termCandidates: [{ source: "combo", target: "组合" }, { source: "fallback", target: "降级" }, { source: "Acme", doNotTranslate: true }] },
    { doc: "b.md", ok: true, termCandidates: [{ source: "combo", target: "组合" }] },
  ]);
  const dry = JSON.parse(tr("glossary", "merge", "--profile", site.profile, "--job-dir", dir, "--run", "m1", "--dry-run").stdout);
  assert.equal(dry.dryRun, true);
  assert.equal(readJsonFile(path.join(site.glossaryDir("zh-CN"), "glossary.json")).version, 1, "dry run changes nothing");

  const r = tr("glossary", "merge", "--profile", site.profile, "--job-dir", dir, "--run", "m1");
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.deepEqual([summary.added, summary.reused, summary.conflicts, summary.version], [2, 1, 1, 3]);
  const g = readJsonFile(path.join(site.glossaryDir("zh-CN"), "glossary.json"));
  assert.equal(g.terms.find((t) => t.id === "fallback").target, "回退", "a locked preferred term is never replaced");
  assert.deepEqual(g.terms.find((t) => t.id === "fallback").conflicts.map((c) => c.target), ["降级"]);
  assert.equal(g.terms.find((t) => t.id === "combo").occurrences, 2);
  assert.deepEqual(g.doNotTranslate.map((t) => t.term), ["Acme"]);
  const log = read(path.join(site.glossaryDir("zh-CN"), "changes.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((c) => c.op).sort(), ["add", "add", "bump", "conflict"]);
  assert.ok(ledger(site).some((e) => e.event === "glossary_change" && e.version === 3));
  assert.equal(snapshot(site).glossaryVersion, 3);
  assert.equal(trJson("scan", "--profile", site.profile).json.glossary.changedOutsideRun, false, "the merge is not mistaken for a human edit");
  assert.equal(readJsonFile(path.join(dir, "a.md", "result.json")).mergedAt !== undefined, true);

  const again = JSON.parse(tr("glossary", "merge", "--profile", site.profile, "--job-dir", dir, "--run", "m2").stdout);
  assert.equal(again.candidates, 0, "merged results are not merged twice");
  assert.equal(readJsonFile(path.join(site.glossaryDir("zh-CN"), "glossary.json")).version, 3);
});

test("locking: the run that holds the lock can merge/adopt under it and keeps it; any other run is refused with exit 3", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "b.md": doc("B") } });
  write(site.content("zh-CN", "b.md"), doc("乙", "你好。"));
  const lockFile = path.join(site.state("zh-CN"), "run.lock");
  const hold = (run) => write(lockFile, JSON.stringify({ run, startedAt: new Date().toISOString() }));
  const cand = write(path.join(tmpDir(), "c.json"), JSON.stringify([{ doc: "a.md", source: "router", target: "路由器" }]));

  hold("main");
  assert.equal(tr("glossary", "merge", "--profile", site.profile, "--file", cand, "--run", "other").status, 3);
  assert.equal(existsSync(path.join(site.glossaryDir("zh-CN"), "glossary.json")), false, "a refused merge writes nothing");
  assert.equal(tr("adopt", "--profile", site.profile, "--run", "other").status, 3);
  const merged = tr("glossary", "merge", "--profile", site.profile, "--file", cand, "--run", "main");
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(tr("adopt", "--profile", site.profile, "--run", "main").status, 0);
  assert.equal(existsSync(lockFile), true, "the orchestrator's lock is still held afterwards");
  assert.equal(readJsonFile(lockFile).run, "main");
  rmSync(lockFile);
  assert.equal(tr("glossary", "merge", "--profile", site.profile, "--file", write(path.join(tmpDir(), "c2.json"), JSON.stringify([{ doc: "a.md", source: "gateway", target: "网关" }])), "--run", "solo").status, 0);
  assert.equal(existsSync(lockFile), false, "a lock taken just for the command is released");
});

test("glossary merge reports collisions in its summary and log, and finalize flags a document whose glossary renders two present terms the same", () => {
  const site = immediate(makeSite({ sources: { "a.md": doc("A", "The agent talks to the proxy.") } }));
  writeGlossary(site, { schema: 1, version: 1, doNotTranslate: [], terms: [{ id: "proxy", source: "proxy", target: "代理", origin: "auto" }] });
  const cand = write(path.join(tmpDir(), "c.json"), JSON.stringify([{ doc: "a.md", source: "agent", target: "代理" }, { doc: "a.md", source: "router", target: "路由器" }]));
  const r = JSON.parse(tr("glossary", "merge", "--profile", site.profile, "--file", cand, "--run", "m1").stdout);
  assert.deepEqual(r.collisions, ["agent → 代理 (already proxy)"]);
  assert.equal(r.added, 1);
  const g = readJsonFile(path.join(site.glossaryDir("zh-CN"), "glossary.json"));
  assert.deepEqual(g.terms.map((t) => t.id), ["proxy", "router"]);
  const log = read(path.join(site.glossaryDir("zh-CN"), "changes.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((c) => c.op === "collision" && c.with === "proxy"));

  // a glossary that (by a human edit) renders both present terms the same → the finished document carries a term-collision flag
  writeGlossary(site, { ...g, terms: [...g.terms, { id: "agent", source: "agent", target: "代理", origin: "human" }] });
  const jobs = nextJobs(site);
  write(jobs.job().output.draft, doc("甲", "代理与代理交互。"));
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 0, fin.stderr);
  assert.equal(fin.json.status, "done_flagged");
  assert.ok(fin.json.flags.some((f) => f.startsWith("term-collision:")), JSON.stringify(fin.json.flags));
});

// ------------------------------------------------------------------------------------------------ automatic glossary growth

const finalizeWith = (site, result, extraArgs = [], draft = ZH) => {
  const jobs = nextJobs(site, "--run", "main", "--doc", "a.md");
  write(jobs.job().output.draft, draft);
  write(jobs.job().output.result, JSON.stringify({ doc: "a.md", ok: true, ...result }));
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile(), "--run", "main", ...extraArgs);
  return { jobs, fin, job: jobs.job() };
};
const glossaryOf = (site) => readJsonFile(path.join(site.glossaryDir("zh-CN"), "glossary.json"));
const CANDS = [{ source: "wizard", target: "向导", note: "setup wizard" }, { source: "Acme", doNotTranslate: true }];

test("finalize folds the job's term candidates into the glossary by itself — no merge call needed", () => {
  const site = immediate(makeSite({ sources: { "a.md": SRC } }));
  writeGlossary(site, GLOSSARY);
  const { fin, job } = finalizeWith(site, { termCandidates: CANDS });
  assert.equal(fin.status, 0, fin.stderr + fin.stdout);
  assert.deepEqual([fin.json.glossary.merged, fin.json.glossary.added, fin.json.glossary.version], [true, 1, 3], "wizard is new; Acme is already a do-not-translate name");
  const g = glossaryOf(site);
  assert.deepEqual(g.terms.map((t) => t.id), ["setup", "wizard"]);
  assert.equal(g.terms.find((t) => t.id === "wizard").origin, "auto");
  assert.deepEqual(g.doNotTranslate.map((t) => t.term), ["Acme"], "an existing do-not-translate name is not duplicated");
  const log = read(path.join(site.glossaryDir("zh-CN"), "changes.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((c) => c.op), ["add"]);
  assert.ok(ledger(site).some((e) => e.event === "glossary_change" && e.version === 3 && /finalize a\.md/.test(e.note)));
  const snap = snapshot(site);
  assert.equal(snap.glossaryVersion, 3);
  assert.equal(trJson("scan", "--profile", site.profile).json.glossary.changedOutsideRun, false, "not mistaken for a human edit");
  assert.equal(readJsonFile(job.output.result).mergedAt !== undefined, true);
  // the terms this very document introduced are tracked for drift too
  assert.deepEqual(snap.docs["a.md"].termTargets, { setup: "安装", wizard: "向导" });
  assert.equal(existsSync(path.join(site.state("zh-CN"), "run.lock")), false, "a lock taken just for the merge is released");
  // a later explicit merge finds nothing left to do
  assert.equal(JSON.parse(tr("glossary", "merge", "--profile", site.profile, "--job-dir", path.dirname(path.dirname(job.output.result)), "--run", "later").stdout).candidates, 0);
});

// ------------------------------------------------------------------------------------------------ automatic growth: the quality gate

const pendingOf = (site) => readJsonFile(path.join(site.glossaryDir("zh-CN"), "pending.json"));
const ZH_B = doc("乙", "再次打开向导。");

test("quality gate (default promoteAfter 2): a first sighting is staged, the next document that uses the rendering promotes it — with no report of its own", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B", "Open the wizard again.") } });
  writeGlossary(site, GLOSSARY);

  const a = finalizeWith(site, { termCandidates: CANDS });
  assert.equal(a.fin.status, 0, a.fin.stderr);
  assert.deepEqual([a.fin.json.glossary.staged, a.fin.json.glossary.added, a.fin.json.glossary.pending, a.fin.json.glossary.version], [1, 0, 1, 2]);
  assert.equal(glossaryOf(site).terms.some((t) => t.id === "wizard"), false, "not a glossary term yet");
  assert.equal(glossaryOf(site).version, 2, "and the version did not move");
  assert.deepEqual(pendingOf(site).entries.map((e) => [e.id, e.target, e.docs]), [["wizard", "向导", ["a.md"]]]);
  const log = read(path.join(site.glossaryDir("zh-CN"), "changes.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((c) => c.op), ["stage"]);
  assert.equal(trJson("scan", "--profile", site.profile).json.glossary.pending, 1);
  assert.match(tr("scan", "--profile", site.profile).stdout, /glossary v2, 1 pending/);
  assert.equal(snapshot(site).glossarySha256, sha(path.join(site.glossaryDir("zh-CN"), "glossary.json")), "the glossary file was not rewritten");

  // the next document gets the pending choice as a suggestion …
  const jobsB = nextJobs(site, "--doc", "b.md", "--run", "main");
  assert.deepEqual(jobsB.job().glossary.pending, [{ source: "wizard", target: "向导", kind: "term", seenIn: 1 }]);
  assert.ok(jobsB.job().instructions.some((l) => /glossary\.pending/.test(l)));
  // … reuses it, reports nothing, and that is enough to confirm it
  write(jobsB.job().output.draft, ZH_B);
  const b = trJson("finalize", "--profile", site.profile, "--job", jobsB.jobFile(), "--run", "main");
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual([b.json.glossary.merged, b.json.glossary.promoted, b.json.glossary.pending, b.json.glossary.version], [true, 1, 0, 3]);
  const term = glossaryOf(site).terms.find((t) => t.id === "wizard");
  assert.deepEqual([term.target, term.origin, term.occurrences, term.firstSeen.doc, term.lastSeen.doc], ["向导", "auto", 2, "a.md", "b.md"]);
  assert.deepEqual(pendingOf(site).entries, []);
  assert.equal(snapshot(site).glossaryVersion, 3);
  assert.deepEqual(snapshot(site).docs["b.md"].termTargets, { wizard: "向导" }, "b.md is now tracked for drift on the promoted term");
  assert.deepEqual(snapshot(site).docs["a.md"].termTargets, { setup: "安装", wizard: "向导" }, "and so is a.md, the document that first chose the rendering");
  assert.equal(trJson("scan", "--profile", site.profile).json.glossary.changedOutsideRun, false);
});

test("quality gate: after a term is promoted, changing it makes BOTH evidencing documents drift", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B", "Open the wizard again.") } });
  writeGlossary(site, GLOSSARY);
  finalizeWith(site, { termCandidates: CANDS });
  const jobsB = nextJobs(site, "--doc", "b.md");
  write(jobsB.job().output.draft, ZH_B);
  assert.equal(trJson("finalize", "--profile", site.profile, "--job", jobsB.jobFile()).json.glossary.promoted, 1);
  const g = glossaryOf(site);
  writeGlossary(site, { ...g, terms: g.terms.map((t) => (t.id === "wizard" ? { ...t, target: "精灵", origin: "human" } : t)) });
  const s = trJson("scan", "--profile", site.profile).json;
  assert.deepEqual(s.pending.filter((p) => p.class === "drift").map((p) => p.doc).sort(), ["a.md", "b.md"]);
});

test("quality gate: a later document that renders the term differently does not confirm it", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B", "Open the wizard again.") } });
  writeGlossary(site, GLOSSARY);
  finalizeWith(site, { termCandidates: CANDS });
  const jobsB = nextJobs(site, "--doc", "b.md");
  write(jobsB.job().output.draft, doc("乙", "再次打开精灵。"));
  const b = trJson("finalize", "--profile", site.profile, "--job", jobsB.jobFile());
  assert.equal(b.json.glossary.promoted, 0);
  assert.equal(pendingOf(site).entries[0].docs.length, 1);
});

test("quality gate: glossary merge --job-dir also confirms by use, for documents that reported no candidates", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B", "Open the wizard again.") } });
  writeGlossary(site, GLOSSARY);
  finalizeWith(site, { termCandidates: CANDS });
  const jobsB = nextJobs(site, "--doc", "b.md");
  write(jobsB.job().output.draft, ZH_B);
  write(jobsB.job().output.result, JSON.stringify({ doc: "b.md", ok: true }));
  const r = JSON.parse(tr("glossary", "merge", "--profile", site.profile, "--job-dir", jobsB.out, "--run", "m1").stdout);
  assert.deepEqual([r.candidates, r.promoted, r.pending, r.version], [0, 1, 0, 3]);
});

test("quality gate: non-terms are rejected and reported with a reason; the profile's ignore list adds more", () => {
  const site = makeSite({ sources: { "a.md": doc("A", "Use the setup wizard of Acme with the files in notes.md.") } });
  writeGlossary(site, GLOSSARY);
  editProfile(site, (t) => `${t}\nglossary:\n  ignore: [wizard]\n`);
  const jobs = nextJobs(site);
  write(jobs.job().output.draft, doc("甲", "使用 Acme 的安装向导和 notes.md 中的文件。"));
  write(jobs.job().output.result, JSON.stringify({ doc: "a.md", ok: true, termCandidates: [
    { source: "files", target: "文件" }, { source: "notes.md", target: "笔记" }, { source: "wizard", target: "向导" },
    { source: "A", target: "甲" }, { source: "sentinel", target: "哨兵" } ] }));
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 0, fin.stderr);
  const reasons = Object.fromEntries(fin.json.glossary.rejected.map((r) => [r.split(/[ :→]/)[0], r.split(": ")[1].split(":")[0]]));
  assert.deepEqual(reasons, { files: "generic", "notes.md": "identifier", wizard: "generic", A: "title", sentinel: "not-in-source" });
  assert.equal(existsSync(path.join(site.glossaryDir("zh-CN"), "pending.json")), false, "nothing was staged, so no pending file is created");
  const log = read(path.join(site.glossaryDir("zh-CN"), "changes.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.filter((c) => c.op === "reject").length, 5, "every rejection is in the audit log");
  assert.equal(fin.json.status, "done", "rejected candidates do not flag the document");
});

test("finalize creates the glossary when the repository has none yet", () => {
  const site = immediate(makeSite({ sources: { "a.md": SRC } }));
  const { fin } = finalizeWith(site, { termCandidates: CANDS });
  assert.equal(fin.json.glossary.merged, true);
  assert.deepEqual(glossaryOf(site).terms.map((t) => t.id), ["wizard"]);
});

test("a term a document introduced is tracked: changing it later makes that document drift", () => {
  const site = immediate(makeSite({ sources: { "a.md": SRC } }));
  writeGlossary(site, GLOSSARY);
  finalizeWith(site, { termCandidates: CANDS });
  const g = glossaryOf(site);
  writeGlossary(site, { ...g, terms: g.terms.map((t) => (t.id === "wizard" ? { ...t, target: "精灵", origin: "human" } : t)) });
  const s = trJson("scan", "--profile", site.profile);
  const p = s.json.pending.find((x) => x.doc === "a.md");
  assert.equal(p.class, "drift");
  assert.match(p.reason, /wizard: 向导 → 精灵/);
});

test("finalize: a colliding candidate is not added and the document carries a term-collision flag", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, { ...GLOSSARY, terms: [...GLOSSARY.terms, { id: "install", source: "install", target: "向导", origin: "human" }] });
  const { fin } = finalizeWith(site, { termCandidates: CANDS });
  assert.equal(fin.status, 0, fin.stderr);
  assert.deepEqual(fin.json.glossary.collisions, ["wizard → 向导 (already install)"]);
  assert.equal(fin.json.status, "done_flagged");
  assert.ok(fin.json.flags.some((f) => f.startsWith("term-collision:") && f.includes("向导")));
  assert.equal(glossaryOf(site).terms.some((t) => t.id === "wizard"), false);
});

test("finalize does not touch the glossary with --no-glossary, with autoGlossary: false, or for a failed result", () => {
  const off = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(off, GLOSSARY);
  const a = finalizeWith(off, { termCandidates: CANDS }, ["--no-glossary"]);
  assert.deepEqual([a.fin.json.glossary.merged, a.fin.json.glossary.reason], [false, "disabled"]);
  assert.equal(glossaryOf(off).version, 2);
  assert.equal(readJsonFile(a.job.output.result).mergedAt, undefined, "still available for a later explicit merge");

  const profileOff = makeSite({ sources: { "a.md": SRC } });
  editProfile(profileOff, (t) => `${t}\nautoGlossary: false\n`);
  writeGlossary(profileOff, GLOSSARY);
  assert.equal(finalizeWith(profileOff, { termCandidates: CANDS }).fin.json.glossary.merged, false);
  assert.equal(glossaryOf(profileOff).version, 2);

  const bad = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(bad, GLOSSARY);
  assert.equal(finalizeWith(bad, { ok: false, termCandidates: CANDS }).fin.json.glossary.merged, false);
  assert.equal(glossaryOf(bad).version, 2);
});

test("finalize never merges twice: a result already marked merged is left alone", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, GLOSSARY);
  const { fin } = finalizeWith(site, { termCandidates: CANDS, mergedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual([fin.json.glossary.merged, fin.json.glossary.reason], [false, "already merged"]);
  assert.equal(glossaryOf(site).version, 2);
});

test("finalize still accepts the document when another run holds the lock; the candidates wait for glossary merge", () => {
  const site = immediate(makeSite({ sources: { "a.md": SRC } }));
  writeGlossary(site, GLOSSARY);
  const lockFile = path.join(site.state("zh-CN"), "run.lock");
  write(lockFile, JSON.stringify({ run: "someone-else", startedAt: new Date().toISOString() }));
  const { fin, job } = finalizeWith(site, { termCandidates: CANDS });
  assert.equal(fin.status, 0, fin.stderr);
  assert.equal(fin.json.glossary.merged, false);
  assert.match(fin.json.glossary.reason, /someone-else holds the lock/);
  assert.equal(glossaryOf(site).version, 2);
  assert.equal(readJsonFile(lockFile).run, "someone-else", "the other run's lock is untouched");
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.fresh, 1, "the document itself was recorded");
  rmSync(lockFile);
  const later = JSON.parse(tr("glossary", "merge", "--profile", site.profile, "--job-dir", path.dirname(path.dirname(job.output.result)), "--run", "later").stdout);
  assert.deepEqual([later.candidates, later.added], [2, 1]);
});

test("finalize under the orchestrator's own lock merges and keeps the lock", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, GLOSSARY);
  const lockFile = path.join(site.state("zh-CN"), "run.lock");
  write(lockFile, JSON.stringify({ run: "main", startedAt: new Date().toISOString() }));
  const { fin } = finalizeWith(site, { termCandidates: CANDS });
  assert.equal(fin.json.glossary.merged, true);
  assert.equal(readJsonFile(lockFile).run, "main");
});

test("finalize releases its lock even when accepting the document fails", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  writeGlossary(site, GLOSSARY);
  const jobs = nextJobs(site, "--run", "r1");
  write(jobs.job().output.draft, SRC); // identical to the source → refused at record time
  write(jobs.job().output.result, JSON.stringify({ doc: "a.md", ok: true, termCandidates: CANDS }));
  const fin = tr("finalize", "--profile", site.profile, "--job", jobs.jobFile(), "--run", "r1");
  assert.notEqual(fin.status, 0);
  assert.equal(existsSync(path.join(site.state("zh-CN"), "run.lock")), false);
  assert.equal(glossaryOf(site).version, 2, "a document that was not recorded adds nothing to the glossary");
});

test("glossary merge: failed jobs are ignored; --file takes a candidate list; a missing glossary is created", () => {
  const site = immediate(makeSite({ sources: { "a.md": doc("A", "The router decides.") } }));
  const dir = resultsDir(site, [{ doc: "a.md", ok: false, termCandidates: [{ source: "router", target: "路由器" }] }]);
  assert.equal(JSON.parse(tr("glossary", "merge", "--profile", site.profile, "--job-dir", dir).stdout).candidates, 0);
  const file = write(path.join(tmpDir(), "cand.json"), JSON.stringify([{ doc: "a.md", source: "router", target: "路由器" }]));
  const r = tr("glossary", "merge", "--profile", site.profile, "--file", file, "--run", "m1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJsonFile(path.join(site.glossaryDir("zh-CN"), "glossary.json")).terms[0].id, "router");
  assert.equal(tr("glossary", "bogus", "--profile", site.profile).status, 2);
  assert.equal(tr("glossary", "merge", "--profile", site.profile, "--file", path.join(site.repo, "none.json")).status, 2);
});

// ------------------------------------------------------------------------------------------------ output template

test("output.template: translations live in the site tree; adopt, scan, next and finalize all follow it", () => {
  const site = makeSite({ sources: { "a.md": SRC, "b.md": doc("B") }, initArgs: ["--output-template", "site/{locale}/{doc}"] });
  write(path.join(site.repo, "site/zh-CN/b.md"), doc("乙", "你好。"));
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.untracked, 1);
  assert.deepEqual(trJson("adopt", "--profile", site.profile).json.adopt, ["b.md"]);
  assert.equal(snapshot(site).docs["b.md"].translationPath, "site/zh-CN/b.md");

  const jobs = nextJobs(site, "--doc", "a.md");
  const j = jobs.job();
  assert.equal(j.output.final, path.join(site.repo, "site/zh-CN/a.md"));
  write(j.output.draft, ZH);
  const fin = trJson("finalize", "--profile", site.profile, "--job", jobs.jobFile());
  assert.equal(fin.status, 0, fin.stderr + fin.stdout);
  assert.equal(read(path.join(site.repo, "site/zh-CN/a.md")), ZH);
  assert.equal(existsSync(site.content("zh-CN", "a.md")), false, "nothing is written to the default location");
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.fresh, 2);
  assert.equal(trJson("status", "--profile", site.profile, "--verify", "--source-root", "docs").json.verify.checked, 2);

  // a --source-root that points nowhere skips every document: that is a failed gate, never a pass
  const lost = trJson("status", "--profile", site.profile, "--verify", "--source-root", "no/such/dir");
  assert.equal(lost.json.verify.checked, 0);
  assert.equal(lost.status, 1, "skipped documents fail the gate");
  assert.ok(lost.json.gates.some((g) => /were not checked/.test(g)), JSON.stringify(lost.json.gates));
});

test("status --verify: passes clean translations and fails when a finished one is damaged", () => {
  const site = makeSite({ sources: { "a.md": SRC } });
  const jobs = nextJobs(site);
  write(jobs.job().output.draft, ZH);
  assert.equal(tr("finalize", "--profile", site.profile, "--job", jobs.jobFile()).status, 0);
  const ok = trJson("status", "--profile", site.profile, "--verify");
  assert.deepEqual([ok.status, ok.json.verify.checked, ok.json.verify.hard.length], [0, 1, 0]);
  writeFileSync(site.content("zh-CN", "a.md"), read(site.content("zh-CN", "a.md")).replace("echo hi", "echo 你好"));
  const bad = trJson("status", "--profile", site.profile, "--verify");
  assert.equal(bad.status, 1);
  assert.ok(bad.json.verify.hard[0].failures.some((f) => f.check === "code-fence"));
  const skipped = trJson("status", "--profile", site.profile, "--verify", "--discovery-file", write(path.join(tmpDir(), "d.ndjson"), JSON.stringify({ doc: "a.md", bytes: 1, sha256: sha(path.join(site.repo, "docs/a.md")), external: false })));
  assert.equal(skipped.json.verify.skipped.length, 1, "unknown source location is reported, not guessed");
});
