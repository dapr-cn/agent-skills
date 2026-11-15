import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGate } from "../../dapr-docs-upstream-pr/scripts/upstream-pr.mjs";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const HEAD = "a".repeat(40);
const DIGEST = "b".repeat(64);
const fresh = (overrides = {}) => ({
  canOpenPr: true,
  verdict: "pass",
  version: "v1.18",
  repo: "repos/v1.18_zh",
  headCommit: HEAD,
  statusDigest: DIGEST,
  generatedAt: new Date(NOW - 5 * 60_000).toISOString(),
  ...overrides,
});
const check = (verdict, extra = {}) => checkGate(verdict, { now: NOW, currentHead: HEAD, currentDigest: DIGEST, version: "v1.18", repo: "repos/v1.18_zh", ...extra });

test("a fresh passing verdict for the current HEAD and status is accepted", () => {
  const r = check(fresh());
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
});

test("a verdict older than the limit is refused and asks for a new gate run", () => {
  const r = check(fresh({ generatedAt: new Date(NOW - 31 * 60_000).toISOString() }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /older than 30 minutes/);
  assert.equal(check(fresh({ generatedAt: new Date(NOW - 31 * 60_000).toISOString() }), { maxAgeMinutes: 60 }).ok, true);
});

test("a verdict whose headCommit is no longer HEAD is refused", () => {
  const r = check(fresh({ headCommit: "c".repeat(40) }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /is not the current HEAD/);
});

test("a verdict whose status digest no longer matches the working tree is refused", () => {
  const r = check(fresh({ statusDigest: "d".repeat(64) }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /status changed/);
});

test("a verdict that did not pass (canOpenPr false) is refused whatever else it says", () => {
  const r = check(fresh({ canOpenPr: false, verdict: "fail" }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /did not pass/);
});

test("a verdict for another version or repository is refused", () => {
  assert.match(check(fresh({ version: "v1.17" })).reasons.join(" "), /is for v1\.17/);
  assert.match(check(fresh({ repo: "repos/v1.17_zh" })).reasons.join(" "), /is for repos\/v1\.17_zh/);
});

test("a verdict without a timestamp, or dated in the future, is refused", () => {
  assert.match(check(fresh({ generatedAt: undefined })).reasons.join(" "), /no valid generatedAt/);
  assert.match(check(fresh({ generatedAt: new Date(NOW + 10 * 60_000).toISOString() })).reasons.join(" "), /in the future/);
});

test("something that is not a verdict is refused", () => {
  assert.equal(checkGate(null, { now: NOW, currentHead: HEAD, currentDigest: DIGEST }).ok, false);
});
