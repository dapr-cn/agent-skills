import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBranches, compareVersions, parseLsRemote, pickPrevious } from "../../dapr-docs-version-bootstrap/scripts/branches.mjs";

test("versions sort numerically: v1.2 < v1.13 < v1.20", () => {
  const { docs } = classifyBranches(["v1.20", "v1.2", "v1.13"].map((name) => ({ name })));
  assert.deepEqual(docs, ["v1.2", "v1.13", "v1.20"]);
  assert.ok(compareVersions("v1.2", "v1.13") < 0);
});

test("only vX.Y and vX.Y_content names are recognised; new_content_vX.Y is ignored", () => {
  const c = classifyBranches(["v1.17", "v1.17_content", "new_content_v1.16", "main", "v1.18_content"].map((name) => ({ name })));
  assert.deepEqual(c.docs, ["v1.17"]);
  assert.deepEqual(c.content, ["v1.17", "v1.18"]);
  assert.deepEqual(c.ignored.sort(), ["main", "new_content_v1.16"]);
});

test("the previous version is the largest lower version that has a translation branch, skipping gaps", () => {
  const content = ["v1.15", "v1.17"];
  assert.equal(pickPrevious({ target: "v1.18", contentVersions: content }), "v1.17");
  assert.equal(pickPrevious({ target: "v1.16", contentVersions: content }), "v1.15");
  assert.equal(pickPrevious({ target: "v1.15", contentVersions: content }), null);
});

test("ls-remote output is parsed into branch names and shas", () => {
  const text = "1111111111111111111111111111111111111111\trefs/heads/v1.17_content\n2222222222222222222222222222222222222222\trefs/heads/v1.18\n";
  assert.deepEqual(parseLsRemote(text), [
    { sha: "1111111111111111111111111111111111111111", name: "v1.17_content" },
    { sha: "2222222222222222222222222222222222222222", name: "v1.18" },
  ]);
});
