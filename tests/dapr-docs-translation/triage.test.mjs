import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { libUrl, makeSite, node, read, tmpDir, tr, trJson, write } from "./helpers.mjs";
import path from "node:path";

const { fixPunctuation } = await import(pathToFileURL(libUrl("punctuation.mjs")).href);
const { judgeFailure, triage } = await import(pathToFileURL(libUrl("triage.mjs")).href);

test("fixPunctuation converts marks next to CJK, pairs parentheses, and leaves code, links, tags and URLs alone", () => {
  const input = [
    "---",
    "title: 标题(测试)",
    "---",
    "",
    "语言:中文,英文.",
    "用 `kubectl`: 查看(详情)的结果!",
    "访问 https://example.org/a,b 查看(链接)[见](https://x.org/a(1).md)中文.",
    "<a href=\"https://x.org/a,b\">页面</a>:说明",
    "",
    "```yaml",
    "key: 值,中文(x)",
    "```",
    "",
  ].join("\n");
  const r = fixPunctuation(input);
  assert.ok(r.text.includes("title: 标题(测试)"), "front matter is not touched");
  assert.ok(r.text.includes("语言：中文，英文。"));
  assert.ok(r.text.includes("`kubectl`： 查看（详情）的结果！"), r.text);
  assert.ok(r.text.includes("https://example.org/a,b"), "URL stays");
  assert.ok(r.text.includes("查看（链接）[见](https://x.org/a(1).md)中文。"), "a link target with parentheses stays whole");
  assert.ok(r.text.includes('<a href="https://x.org/a,b">页面</a>:说明'), "a mark after a tag is not next to CJK text");
  assert.ok(r.text.includes("key: 值,中文(x)"), "fenced code stays");
  assert.deepEqual(fixPunctuation(r.text).fixes, [], "idempotent");
});

test("fixPunctuation leaves a fenced block nested in a list item alone, however deep it is indented", () => {
  const input = "1. 步骤:\n\n    ```go\n    // 启动服务:这里\n    f(1)\n    ```\n\n2. 完成.\n";
  const r = fixPunctuation(input);
  assert.ok(r.text.includes("    // 启动服务:这里\n"), r.text);
  assert.ok(r.text.includes("1. 步骤：") && r.text.includes("2. 完成。"));
});

test("fixPunctuation does not guess: a dot inside a file name is reported, not converted", () => {
  const r = fixPunctuation("配置文件名为config.yaml,请看。\n端口号是中文.yaml\n");
  assert.ok(r.text.includes("config.yaml"));
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].context, /文\.yaml/);
});

test("fixPunctuation: the repaired text passes the checker's CJK punctuation rule, the original does not", () => {
  const dir = tmpDir("dt-punct-");
  const en = write(path.join(dir, "en.md"), "# T\n\nUse the flag (see docs): it works.\n");
  const bad = "# 标题\n\n使用该标志(参见文档):它有效.\n";
  const before = write(path.join(dir, "before.md"), bad);
  const after = write(path.join(dir, "after.md"), fixPunctuation(bad).text);
  assert.equal(node("check-translation.mjs", [en, before, "--cjk-punctuation"]).status, 1);
  assert.equal(node("check-translation.mjs", [en, after, "--cjk-punctuation"]).status, 0);
});

test("judgeFailure: structural loss retranslates, same-shape differences are reviewed, punctuation is automatic", () => {
  const j = (check, message) => judgeFailure({ check, message }).class;
  assert.equal(j("cjk-punctuation", "2 ASCII punctuation mark(s)"), "auto");
  assert.equal(j("headings", "heading level sequence differs (2 vs 6 headings)"), "retranslate");
  assert.equal(j("tables", "table shapes differ: [10x4] vs [53x4]"), "retranslate");
  assert.equal(j("code-fence", "fenced block count 3 vs 2"), "retranslate");
  assert.equal(j("code-fence", "fenced block #2 differs from the source beyond comment text"), "review");
  assert.equal(j("links", "link/image targets differ (1 vs 0); first difference at #1: \"a\" vs undefined"), "retranslate");
  assert.equal(j("links", "link/image targets differ (3 vs 3); first difference at #1: \"a\" vs \"b\""), "review");
  assert.equal(j("inline-code", "inline code spans differ (9 vs 8); e.g. \"x\""), "review");
  assert.equal(j("inline-code", "inline code spans differ (20 vs 8); e.g. \"x\""), "retranslate");
  assert.equal(j("html", "HTML tag multiset differs"), "review");
});

test("triage: a document takes its worst class and the list is worst first", () => {
  const out = triage([
    { doc: "b.md", failures: [{ check: "cjk-punctuation", message: "1 ASCII punctuation mark(s)" }] },
    { doc: "a.md", failures: [{ check: "cjk-punctuation", message: "x" }, { check: "headings", message: "heading level sequence differs (1 vs 5 headings)" }] },
    { doc: "c.md", failures: [{ check: "html", message: "HTML tag multiset differs" }] },
  ]);
  assert.deepEqual(out.map((d) => [d.doc, d.class]), [["a.md", "retranslate"], ["c.md", "review"], ["b.md", "auto"]]);
});

const SRC = (extra = "") => `# Guide\n\nSee the flag (docs): it works.\n\n## Setup\n\nRun it.\n${extra}`;

function siteWithFailures() {
  const site = makeSite({ sources: { "ok.md": SRC(), "punct.md": SRC(), "lost.md": SRC(), "more.md": SRC() } });
  write(site.content("zh-CN", "ok.md"), "# 指南\n\n参见该标志（文档）：它有效。\n\n## 安装\n\n运行它。\n");
  write(site.content("zh-CN", "punct.md"), "# 指南\n\n参见该标志(文档):它有效。\n\n## 安装\n\n运行它。\n");
  write(site.content("zh-CN", "lost.md"), "# 指南\n\n参见该标志（文档）：它有效。\n\n运行它。\n");
  write(site.content("zh-CN", "more.md"), "# 指南\n\n参见该标志（文档）：它有效。\n\n## 安装\n\n运行它。\n");
  assert.equal(tr("adopt", "--profile", site.profile).status, 0);
  return site;
}

test("triage CLI sorts failures, writes the lists, and fix-punctuation then clears the automatic class", () => {
  const site = siteWithFailures();
  const t = trJson("triage", "--profile", site.profile, "--source-root", "docs");
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(t.json.counts, { retranslate: 1, review: 0, auto: 1 });
  assert.deepEqual(t.json.docs.map((d) => [d.doc, d.class]), [["lost.md", "retranslate"], ["punct.md", "auto"]]);

  const out = path.join(path.dirname(site.repo), "triage-out");
  const listed = tr("triage", "--profile", site.profile, "--source-root", "docs", "--out-dir", out);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(read(path.join(out, "retranslate.txt")), "lost.md\n");
  assert.equal(read(path.join(out, "auto.txt")), "punct.md\n");

  const fixed = trJson("fix-punctuation", "--profile", site.profile);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.deepEqual(fixed.json.changed.map((c) => c.doc), ["punct.md"]);
  assert.match(read(site.content("zh-CN", "punct.md")), /（文档）：它有效/);
  // the document stayed fresh: its new hash is recorded
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.fresh, 4);
  assert.deepEqual(trJson("triage", "--profile", site.profile, "--source-root", "docs").json.counts, { retranslate: 1, review: 0, auto: 0 });
});

test("requeue sends the retranslate class back to the backlog as stale; dry-run changes nothing; auto is not accepted", () => {
  const site = siteWithFailures();
  assert.equal(tr("fix-punctuation", "--profile", site.profile).status, 0);
  const dry = trJson("requeue", "--profile", site.profile, "--triage", "retranslate", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.json.requeue, ["lost.md"]);
  assert.equal(trJson("scan", "--profile", site.profile).json.summary.stale ?? 0, 0, "dry-run writes nothing");

  assert.equal(tr("requeue", "--profile", site.profile, "--triage", "auto").status, 2);

  const real = trJson("requeue", "--profile", site.profile, "--triage", "retranslate");
  assert.equal(real.status, 0, real.stderr);
  const scan = trJson("scan", "--profile", site.profile).json;
  assert.equal(scan.summary.stale, 1);
  assert.equal(scan.summary.fresh, 3);
  assert.ok(JSON.stringify(scan).includes("lost.md"));
  // the old translation stays as reference and is not touched
  assert.match(read(site.content("zh-CN", "lost.md")), /运行它/);
  const ledger = read(path.join(site.state("zh-CN"), "ledger.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(ledger.some((e) => e.event === "doc_requeued" && e.doc === "lost.md"));
  // asking again is harmless: it is already stale
  assert.deepEqual(trJson("requeue", "--profile", site.profile, "--triage", "retranslate", "--dry-run").json.requeue, []);
});

test("triage refuses to judge when documents could not be checked", () => {
  const site = siteWithFailures();
  const r = tr("triage", "--profile", site.profile, "--source-root", "no/such");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not be checked/);
});
