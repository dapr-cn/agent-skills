import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendEntries, entryPaths } from "../../dapr-docs-version-bootstrap/scripts/monospecs-edit.mjs";
import { agentSkillsDir } from "../_fixtures/mono.mjs";
import { parseYaml } from "../../dapr-docs-version-bootstrap/scripts/lib/yaml.mjs";

// The fixture is a copy of the real monospecs (comments, optional entries and all), read-only here.
const realMonospecs = path.resolve(agentSkillsDir, "..", "..", ".hagicode", "monospecs.yaml");
const original = existsSync(realMonospecs) ? readFileSync(realMonospecs, "utf8") : null;
const UP = "https://github.com/dapr/docs.git";
const ZH = "https://github.com/dapr/docs-zh.git";

test("new entries are appended and the existing text is kept byte for byte", { skip: !original && "monospecs.yaml not found" }, () => {
  const r = appendEntries(original, { version: "v1.18", upstreamUrl: UP, zhUrl: ZH });
  assert.equal(r.present, false);
  assert.deepEqual(r.added, ["repos/v1.18", "repos/v1.18_zh"]);
  assert.ok(r.text.startsWith(original), "the original text must be a prefix of the result");
  const doc = parseYaml(r.text);
  const up = doc.repositories.find((x) => x.path === "repos/v1.18");
  const zh = doc.repositories.find((x) => x.path === "repos/v1.18_zh");
  assert.equal(up.url, UP);
  assert.equal(up.branch, "v1.18");
  assert.equal(up.optional, true);
  assert.equal(zh.url, ZH);
  assert.equal(zh.branch, "v1.18_content");
  assert.equal(zh.optional, true);
});

test("running it again on its own output changes nothing", { skip: !original && "monospecs.yaml not found" }, () => {
  const first = appendEntries(original, { version: "v1.18", upstreamUrl: UP, zhUrl: ZH });
  const second = appendEntries(first.text, { version: "v1.18", upstreamUrl: UP, zhUrl: ZH });
  assert.equal(second.present, true);
  assert.deepEqual(second.added, []);
  assert.equal(second.text, first.text);
  const paths = [...entryPaths(second.text)].filter((p) => p.endsWith("v1.18") || p.endsWith("v1.18_zh"));
  assert.equal(paths.length, 2, "no duplicate entries");
});

test("only the missing entry is added when one of the two already exists", () => {
  const text = `repositories:\n- path: "repos/v1.18_zh"\n  url: "${ZH}"\n  branch: "v1.18_content"\n`;
  const r = appendEntries(text, { version: "v1.18", upstreamUrl: UP, zhUrl: ZH });
  assert.deepEqual(r.added, ["repos/v1.18"]);
  assert.equal(entryPaths(r.text).size, 2);
  assert.ok(r.text.startsWith(text));
});

test("comments in the existing file survive the append", () => {
  const text = `# keep this comment\nrepositories:\n- path: "repos/v1.17"\n  url: "${UP}"\n  branch: "v1.17"\n# and this one\n`;
  const r = appendEntries(text, { version: "v1.18", upstreamUrl: UP, zhUrl: ZH });
  assert.ok(r.text.includes("# keep this comment"));
  assert.ok(r.text.startsWith(text.endsWith("\n") ? text : `${text}\n`));
});
