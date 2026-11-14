import assert from "node:assert/strict";
import { test } from "node:test";
import { libUrl } from "./helpers.mjs";

const { termsIn, termTargetsOf, proseOf, slugOf, jobSlug } = await import(libUrl("jobs.mjs"));
const { mergeCandidates, emptyGlossary, emptyPending, screenCandidate, docTitleOf, GLOSSARY_OPS } = await import(libUrl("glossary.mjs"));

const glossary = {
  terms: [
    { id: "fallback", source: "fallback", target: "回退" },
    { id: "rate-limit", source: "rate limit", target: "速率限制" },
    { id: "combo", source: "combo", target: "组合" },
  ],
  doNotTranslate: [{ term: "OmniRoute", note: "product" }],
};

test("terms match case-insensitively on word boundaries, with plurals and space/hyphen variants", () => {
  const found = termsIn("Fallbacks happen. A Rate-Limit applies; the rate limit resets. Combos are not combo-ish? OmniRoute rocks.", glossary);
  assert.deepEqual(found.terms.map((t) => t.id).sort(), ["combo", "fallback", "rate-limit"]);
  assert.deepEqual(found.doNotTranslate.map((t) => t.term), ["OmniRoute"]);
});

test("words that merely contain a term do not match", () => {
  const found = termsIn("A fallbackish thing and uncombo.", glossary);
  assert.equal(found.terms.length, 0);
});

test("code spans and fenced code are ignored", () => {
  const text = "Use `fallback` here.\n\n```bash\nfallback --combo\n```\n\nNothing else.";
  assert.equal(proseOf(text).includes("fallback"), false);
  assert.equal(termsIn(text, glossary).terms.length, 0);
});

test("termTargets maps id to target; slugs are stable", () => {
  assert.deepEqual(termTargetsOf(glossary.terms.slice(0, 2)), { fallback: "回退", "rate-limit": "速率限制" });
  assert.equal(slugOf("Rate Limit"), "rate-limit");
  assert.equal(jobSlug("docs/guides/A.md"), "docs__guides__A.md");
});

test("merge: new terms are added, same wording bumps occurrences and reaches high confidence", () => {
  const first = mergeCandidates(emptyGlossary(), [{ doc: "a.md", source: "Fallback", target: "回退" }], { run: "r1" });
  assert.equal(first.glossary.terms[0].id, "fallback");
  assert.equal(first.glossary.terms[0].origin, "auto");
  assert.equal(first.glossary.terms[0].confidence, "medium");
  assert.equal(first.glossary.version, 1);
  let g = first.glossary;
  for (const doc of ["b.md", "c.md"]) g = mergeCandidates(g, [{ doc, source: "fallback", target: "回退" }], { run: "r2" }).glossary;
  assert.equal(g.terms[0].occurrences, 3);
  assert.equal(g.terms[0].confidence, "high");
  assert.equal(g.version, 3);
});

test("merge: a different wording is recorded as a conflict and never replaces the preferred target", () => {
  const g0 = { ...emptyGlossary(), version: 5, terms: [{ id: "fallback", source: "fallback", target: "回退", origin: "human", locked: true, occurrences: 4, conflicts: [] }] };
  const out = mergeCandidates(g0, [{ doc: "a.md", source: "fallback", target: "降级" }, { doc: "b.md", source: "fallback", target: "降级" }], { run: "r1" });
  assert.equal(out.glossary.terms[0].target, "回退");
  assert.deepEqual(out.glossary.terms[0].conflicts.map((c) => c.target), ["降级"], "the same alternative is not recorded twice");
  assert.equal(out.changes.filter((c) => c.op === "conflict").length, 1);
});

test("merge: one version step per document that changed something; no-op documents do not bump", () => {
  const g0 = { ...emptyGlossary(), version: 2 };
  const out = mergeCandidates(g0, [
    { doc: "a.md", source: "alpha", target: "甲" }, { doc: "a.md", source: "beta", target: "乙" },
    { doc: "b.md", source: "gamma", target: "丙" },
    { doc: "c.md", source: "", target: "x" }, { doc: "c.md", source: "noTarget" },
  ], { run: "r1" });
  assert.equal(out.versionBumps, 2);
  assert.equal(out.glossary.version, 4);
  assert.deepEqual(out.changes.map((c) => [c.id, c.version]), [["alpha", 3], ["beta", 3], ["gamma", 4]]);
  assert.deepEqual(out.glossary.terms.map((t) => t.id), ["alpha", "beta", "gamma"], "sorted by id");
});

test("merge: do-not-translate names are added once and the input is not mutated", () => {
  const g0 = emptyGlossary();
  const out = mergeCandidates(g0, [{ doc: "a.md", source: "Acme", doNotTranslate: true }, { doc: "b.md", source: "acme", doNotTranslate: true }], { run: "r1" });
  assert.equal(out.glossary.doNotTranslate.length, 1);
  assert.equal(g0.doNotTranslate.length, 0);
});

test("merge: a candidate whose rendering already belongs to another term is refused as a collision, not added", () => {
  const g0 = { ...emptyGlossary(), version: 4, terms: [{ id: "proxy", source: "proxy", target: "代理", origin: "auto", occurrences: 2, conflicts: [] }] };
  const out = mergeCandidates(g0, [{ doc: "a.md", source: "Agent", target: "代理" }], { run: "r1" });
  assert.equal(out.glossary.terms.length, 1, "the colliding term is not added");
  assert.deepEqual(out.changes, [{ op: "collision", id: "agent", target: "代理", with: "proxy", version: 4, doc: "a.md" }]);
  assert.equal(out.versionBumps, 0, "a refused collision changes nothing, so the version stays");
  // other candidates of the same document are still merged
  const mixed = mergeCandidates(g0, [{ doc: "a.md", source: "Agent", target: "代理" }, { doc: "a.md", source: "router", target: "路由器" }], { run: "r1" });
  assert.deepEqual(mixed.glossary.terms.map((t) => t.id), ["proxy", "router"]);
  assert.equal(mixed.versionBumps, 1);
  // the same word with the same rendering is a reuse, never a collision
  assert.equal(mergeCandidates(g0, [{ doc: "a.md", source: "proxy", target: "代理" }], { run: "r1" }).changes[0].op, "bump");
});

// ------------------------------------------------------------------------------------------------ quality gate: screening

const SRC_TEXT = "---\ntitle: \"Inference Auth Posture\"\n---\n\n# Inference Auth Posture\n\nThe circuit breaker opens when the Model Context Protocol server fails. Set `forcedConnectionId` in config.yaml.\n";
const ctxOf = (translation) => ({ source: SRC_TEXT, translation, title: docTitleOf(SRC_TEXT) });

test("screenCandidate: what a glossary term is not", () => {
  const T = "断路器在模型上下文协议服务器失败时打开。";
  const reject = (c, expected, ctx = ctxOf(T)) => assert.match(screenCandidate(c, ctx) ?? "PASSED", expected, JSON.stringify(c));
  reject({ source: "", target: "x" }, /^empty/);
  reject({ source: "breaker" }, /^empty/);
  reject({ source: "docs/guides/X.md", target: "指南" }, /^identifier/);
  reject({ source: "config.yaml", target: "配置" }, /^identifier/);
  reject({ source: "--dry-run", target: "试运行" }, /^identifier/);
  reject({ source: "forcedConnectionId", target: "强制连接" }, /^identifier/);
  reject({ source: "getUser", target: "获取用户" }, /^identifier/);
  reject({ source: "x_y", target: "z" }, /^identifier/);
  reject({ source: "`code`", target: "代码" }, /^identifier/);
  reject({ source: "the circuit breaker opens when the server fails", target: "断路器打开" }, /^too-long/);
  reject({ source: "ab", target: "甲乙" }, /^too-short/);
  reject({ source: "Files", target: "文件" }, /^generic/);
  reject({ source: "option", target: "选项" }, /^generic/);
  reject({ source: "Inference Auth Posture", target: "推理认证姿态" }, /^title/);
  reject({ source: "circuit breaker", target: "circuit breaker" }, /^untranslated/);
  reject({ source: "circuit breaker", target: "x".repeat(31) }, /^too-long/);
  reject({ source: "wizard", target: "向导" }, /^not-in-source/);
  reject({ source: "circuit breaker", target: "熔断器" }, /^not-used/);
  reject({ source: "Acme", doNotTranslate: true }, /^not-in-source/);
  reject({ source: "Model Context Protocol", doNotTranslate: true }, /^not-used/);
});

test("screenCandidate: what passes", () => {
  const T = "断路器在 Model Context Protocol 服务器失败时打开。";
  for (const c of [{ source: "circuit breaker", target: "断路器" }, { source: "Circuit Breakers", target: "断路器" }, { source: "Model Context Protocol", doNotTranslate: true }]) {
    assert.equal(screenCandidate(c, ctxOf(T)), null, JSON.stringify(c));
  }
  assert.equal(screenCandidate({ source: "MCP", target: "模型上下文协议" }, {}), null, "short all-caps names are fine, and text checks are skipped when the text is unknown");
  assert.equal(screenCandidate({ source: "gateway", target: "网关" }, { ignore: new Set() }), null);
  assert.match(screenCandidate({ source: "gateway", target: "网关" }, { ignore: new Set(["gateway"]) }), /^generic/, "the profile's ignore list extends the generic words");
  assert.match(screenCandidate({ source: "api gateway", target: "API 网关" }, { ignore: new Set(["api gateway"]) }), /^generic/, "multi-word ignore entries work too");
});

test("docTitleOf: frontmatter title, else the first level-1 heading", () => {
  assert.equal(docTitleOf('---\ntitle: "Guide: setup"\n---\n# Other\n'), "Guide: setup");
  assert.equal(docTitleOf("---\ntitle: Plain\n---\n"), "Plain");
  assert.equal(docTitleOf("# Heading\n\ntext"), "Heading");
  assert.equal(docTitleOf("no title here"), null);
});

// ------------------------------------------------------------------------------------------------ quality gate: staging

const doc2 = (source, translation) => ({ source, translation, title: "T" });
const opts = (contexts, extra = {}) => ({ run: "r1", promoteAfter: 2, contextOf: (d) => contexts[d] ?? null, ...extra });

test("staging: a first sighting waits in pending — the glossary and its version do not change", () => {
  const ctx = { "a.md": doc2("The router decides.", "路由器决定。") };
  const out = mergeCandidates({ ...emptyGlossary(), version: 3 }, [{ doc: "a.md", source: "router", target: "路由器" }], opts(ctx));
  assert.equal(out.glossary.terms.length, 0);
  assert.equal(out.glossary.version, 3);
  assert.equal(out.versionBumps, 0);
  assert.deepEqual(out.pending.entries.map((e) => [e.id, e.target, e.docs]), [["router", "路由器", ["a.md"]]]);
  assert.deepEqual(out.changes.map((c) => c.op), ["stage"]);
  assert.equal(out.changes.every((c) => !GLOSSARY_OPS.has(c.op)), true);
});

test("staging: a second document reporting the same rendering promotes it; reporting twice from one document does not", () => {
  const ctx = { "a.md": doc2("The router decides.", "路由器决定。"), "b.md": doc2("Another router.", "另一个路由器。") };
  const first = mergeCandidates(emptyGlossary(), [{ doc: "a.md", source: "router", target: "路由器" }, { doc: "a.md", source: "Router", target: "路由器" }], opts(ctx));
  assert.equal(first.glossary.terms.length, 0, "the same document twice is still one document");
  const second = mergeCandidates(first.glossary, [{ doc: "b.md", source: "router", target: "路由器" }], opts(ctx, { pending: first.pending }));
  const term = second.glossary.terms[0];
  assert.deepEqual([term.id, term.target, term.origin, term.occurrences, term.confidence], ["router", "路由器", "auto", 2, "medium"]);
  assert.equal(term.firstSeen.doc, "a.md");
  assert.equal(term.lastSeen.doc, "b.md");
  assert.equal(second.pending.entries.length, 0);
  assert.deepEqual(second.changes.map((c) => c.op), ["confirm", "promote"]);
  assert.equal(second.versionBumps, 1);
});

test("staging: confirmation by use — a later document with the term in its source and the rendering in its translation promotes it without reporting it", () => {
  const ctx = { "a.md": doc2("The router decides.", "路由器决定。"), "b.md": doc2("Use the router.", "使用路由器。"), "c.md": doc2("Nothing relevant.", "无关。"), "d.md": doc2("A router again.", "又一个路由。") };
  const first = mergeCandidates(emptyGlossary(), [{ doc: "a.md", source: "router", target: "路由器" }], opts(ctx));
  const unrelated = mergeCandidates(first.glossary, [], opts(ctx, { pending: first.pending, docs: ["c.md"] }));
  assert.equal(unrelated.pending.entries[0].docs.length, 1, "no mention of the term: no confirmation");
  const otherWording = mergeCandidates(first.glossary, [], opts(ctx, { pending: first.pending, docs: ["d.md"] }));
  assert.equal(otherWording.pending.entries[0].docs.length, 1, "the term is there but rendered differently: no confirmation");
  const used = mergeCandidates(first.glossary, [], opts(ctx, { pending: first.pending, docs: ["b.md"] }));
  assert.equal(used.glossary.terms[0].id, "router");
  assert.deepEqual(used.changes.map((c) => [c.op, c.by]), [["confirm", "use"], ["promote", undefined]]);
  const same = mergeCandidates(first.glossary, [], opts(ctx, { pending: first.pending, docs: ["a.md"] }));
  assert.equal(same.pending.entries[0].docs.length, 1, "the document that introduced it cannot confirm it");
});

test("staging: do-not-translate names are staged and confirmed the same way (the name must appear verbatim)", () => {
  const ctx = { "a.md": doc2("Acme Router is great.", "Acme Router 很棒。"), "b.md": doc2("Ask Acme Router.", "询问 Acme Router。") };
  const first = mergeCandidates(emptyGlossary(), [{ doc: "a.md", source: "Acme Router", doNotTranslate: true }], opts(ctx));
  assert.equal(first.glossary.doNotTranslate.length, 0);
  const second = mergeCandidates(first.glossary, [], opts(ctx, { pending: first.pending, docs: ["b.md"] }));
  assert.deepEqual(second.glossary.doNotTranslate.map((t) => t.term), ["Acme Router"]);
});

test("staging: competing renderings — the one that reaches the threshold wins and the other becomes a recorded conflict", () => {
  const ctx = { "a.md": doc2("The router.", "路由器。"), "b.md": doc2("The router.", "路由。"), "c.md": doc2("The router.", "路由器。") };
  let state = { glossary: emptyGlossary(), pending: emptyPending() };
  for (const [doc, target] of [["a.md", "路由器"], ["b.md", "路由"], ["c.md", "路由器"]]) {
    state = mergeCandidates(state.glossary, [{ doc, source: "router", target }], opts(ctx, { pending: state.pending }));
  }
  const term = state.glossary.terms[0];
  assert.equal(term.target, "路由器");
  assert.deepEqual(term.conflicts.map((c) => c.target), ["路由"]);
  assert.equal(state.pending.entries.length, 0, "no stale variants are left behind");
});

test("staging: three agreeing documents give high confidence; promoteAfter 1 admits at once", () => {
  const ctx = Object.fromEntries(["a", "b", "c"].map((n) => [`${n}.md`, doc2("The router.", "路由器。")]));
  let state = { glossary: emptyGlossary(), pending: emptyPending() };
  for (const doc of ["a.md", "b.md"]) state = mergeCandidates(state.glossary, [{ doc, source: "router", target: "路由器" }], opts(ctx, { pending: state.pending, promoteAfter: 3 }));
  assert.equal(state.glossary.terms.length, 0);
  state = mergeCandidates(state.glossary, [{ doc: "c.md", source: "router", target: "路由器" }], opts(ctx, { pending: state.pending, promoteAfter: 3 }));
  assert.deepEqual([state.glossary.terms[0].occurrences, state.glossary.terms[0].confidence], [3, "high"]);
  const now = mergeCandidates(emptyGlossary(), [{ doc: "a.md", source: "router", target: "路由器" }], opts(ctx, { promoteAfter: 1 }));
  assert.deepEqual([now.glossary.terms.length, now.changes[0].op], [1, "add"]);
});

test("rejections are logged with their reason, never staged, and do not bump the version", () => {
  const ctx = { "a.md": { source: "# Posture Guide\n\nSee the files.", translation: "参见文件。", title: "Posture Guide" } };
  const out = mergeCandidates(emptyGlossary(), [{ doc: "a.md", source: "Posture Guide", target: "姿态指南" }, { doc: "a.md", source: "files", target: "文件" }, { doc: "a.md", source: "notes.md", target: "笔记" }], opts(ctx));
  assert.deepEqual(out.changes.map((c) => c.op), ["reject", "reject", "reject"]);
  assert.deepEqual(out.rejected.map((r) => r.reason.split(":")[0]), ["title", "generic", "identifier"]);
  assert.equal(out.pending.entries.length, 0);
  assert.equal(out.versionBumps, 0);
});

test("staging: a candidate that collides with an existing rendering is refused before it is staged", () => {
  const g0 = { ...emptyGlossary(), version: 1, terms: [{ id: "proxy", source: "proxy", target: "代理", origin: "auto", conflicts: [] }] };
  const ctx = { "a.md": doc2("The agent.", "代理。") };
  const out = mergeCandidates(g0, [{ doc: "a.md", source: "agent", target: "代理" }], opts(ctx));
  assert.deepEqual(out.changes.map((c) => c.op), ["collision"]);
  assert.equal(out.pending.entries.length, 0);
});

test("screenCandidate: CamelCase product names are names, not code identifiers", () => {
  for (const name of ["OmniRoute", "OpenAI", "LiteLLM", "OpenCode", "GitHub", "iPhone".replace("iPhone", "HagiCode")]) {
    assert.equal(screenCandidate({ source: name, doNotTranslate: true }, {}), null, name);
  }
  assert.match(screenCandidate({ source: "forcedConnectionId", doNotTranslate: true }, {}), /^identifier/, "a lowerCamel code symbol still is one");
});

test("screenCandidate: all-lowercase multi-word terms are fine (only bootstrap rejects Capitalised sentence fragments)", () => {
  for (const term of ["synthetic tool call", "reasoning replay cache", "circuit breaker", "session affinity"]) {
    assert.equal(screenCandidate({ source: term, target: "译法" }, {}), null, term);
  }
});
