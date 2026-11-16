import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { doc, libUrl, makeSite, read, readJsonFile, sha, tr, trJson, write } from "./helpers.mjs";
import path from "node:path";

const { fixAnchors, headingList, slugList } = await import(pathToFileURL(libUrl("anchors.mjs")).href);

const EN = "# Guide\n\nSee [setup](#setup-guide) and [api](#the-api) and [x](#nowhere).\n\n## Setup guide\n\n```md\n## Not a heading\n[c](#setup-guide)\n```\n\n## The `dapr run` API\n";
const ZH = "# 指南\n\n参见[安装](#setup-guide)、[接口](#the-dapr-run-api)和 `[c](#setup-guide)`。[x](#nowhere)\n\n## 安装指南\n\n```md\n## Not a heading\n[c](#setup-guide)\n```\n\n## `dapr run` 接口\n";

test("slugs: code text counts, punctuation drops, duplicates get suffixes, fences are ignored", () => {
  assert.deepEqual(slugList(headingList("# A b\n\n## What's new?\n\n## What's new?\n\n```\n# no\n```\n\n## snake_case `x_y`\n")), ["a-b", "whats-new", "whats-new-1", "snake_case-x_y"]);
});

test("fixAnchors retargets only unresolved fragments that name a source heading; code and unknown fragments stay", () => {
  const r = fixAnchors(`${EN.replace("[api](#the-api)", "[api](#the-dapr-run-api)")}`, ZH);
  assert.equal(r.skipped, null);
  assert.deepEqual(r.fixes.map((f) => [f.from, f.to]), [["setup-guide", "安装指南"], ["the-dapr-run-api", "dapr-run-接口"]]);
  assert.ok(r.text.includes("[安装](#安装指南)"));
  assert.ok(r.text.includes("`[c](#setup-guide)`"), "inline code untouched");
  assert.ok(r.text.includes("```md\n## Not a heading\n[c](#setup-guide)\n```"), "fenced code untouched");
  assert.deepEqual(r.unresolved.map((u) => u.fragment), ["nowhere"]);
  assert.equal(fixAnchors(EN, r.text).fixes.length, 0, "idempotent");
});

test("fixAnchors skips a document whose heading structure differs", () => {
  const r = fixAnchors("# A\n\n## B\n", "# 甲\n");
  assert.match(r.skipped, /heading structure differs/);
  assert.equal(r.text, "# 甲\n");
});

test("fix-anchors CLI: fresh stays fresh (rehash in snapshot and ledger), untracked is written without state, stale is skipped", () => {
  const src = (t) => `# ${t}\n\nSee [s](#setup).\n\n## Setup\n`;
  const site = makeSite({ sources: { "a.md": src("A"), "b.md": src("B"), "c.md": src("C") } });
  for (const n of ["a.md", "b.md"]) write(site.content("zh-CN", n), "# 甲\n\n见[安](#setup)。\n\n## 安装\n");
  assert.equal(tr("adopt", "--profile", site.profile, "--only", "a.md").status, 0);
  // c.md is recorded, then its source changes: stale
  write(site.content("zh-CN", "c.md"), "# 丙\n\n见[安](#setup)。\n\n## 安装\n");
  assert.equal(tr("adopt", "--profile", site.profile, "--only", "c.md").status, 0);
  site.src("c.md", `${src("C")}\nmore\n`);

  const dry = trJson("fix-anchors", "--profile", site.profile, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.json.changed.map((c) => c.doc).sort(), ["a.md", "b.md"]);
  assert.match(read(site.content("zh-CN", "a.md")), /\(#setup\)/, "dry-run writes nothing");

  const real = trJson("fix-anchors", "--profile", site.profile);
  assert.equal(real.status, 0, real.stderr);
  assert.match(read(site.content("zh-CN", "a.md")), /\(#安装\)/);
  assert.match(read(site.content("zh-CN", "b.md")), /\(#安装\)/);
  assert.match(read(site.content("zh-CN", "c.md")), /\(#setup\)/, "stale document untouched");
  assert.ok(real.json.skipped.some((s) => s.doc === "c.md"));

  const snap = readJsonFile(path.join(site.state("zh-CN"), "snapshot.json"));
  assert.equal(snap.docs["a.md"].translationSha256, sha(site.content("zh-CN", "a.md")));
  assert.ok(read(path.join(site.state("zh-CN"), "ledger.jsonl")).includes("doc_rehashed"));
  const scan = trJson("scan", "--profile", site.profile);
  assert.equal(scan.json.summary.fresh, 1, "a.md is still fresh, not edited");
  assert.equal(scan.json.summary.untracked, 1, "b.md is still untracked");
  assert.equal(scan.json.summary.stale, 1);
  assert.equal(trJson("fix-anchors", "--profile", site.profile).json.changed.length, 0, "second run is a no-op");
});

test("adopt --as-stale / --only-from: the translation becomes a stale reference, not a fresh baseline", () => {
  const site = makeSite({ sources: { "a.md": doc("A"), "b.md": doc("B") } });
  write(site.content("zh-CN", "a.md"), doc("甲", "你好。"));
  write(site.content("zh-CN", "b.md"), doc("乙", "你好。"));
  const list = write(path.join(site.repo, "list.txt"), "a.md\n");
  const r = trJson("adopt", "--profile", site.profile, "--only-from", list, "--as-stale");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.adopt, ["a.md"]);
  const s = trJson("scan", "--profile", site.profile);
  assert.deepEqual([s.json.summary.stale, s.json.summary.fresh, s.json.summary.untracked], [1, 0, 1]);
  assert.ok(s.json.pending.some((p) => p.doc === "a.md" && p.class === "stale"));
  assert.match(read(path.join(site.state("zh-CN"), "snapshot.json")), /adopted as stale/);
});
