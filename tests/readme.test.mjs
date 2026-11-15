// The skills table in README.md: each new skill has exactly one row, and each link points at an existing SKILL.md of that skill.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { agentSkillsDir } from "./_fixtures/mono.mjs";

const NEW_SKILLS = ["dapr-docs-translate-incremental", "dapr-docs-translation-verify", "dapr-docs-version-bootstrap", "dapr-docs-upstream-pr"];
const readme = readFileSync(path.join(agentSkillsDir, "README.md"), "utf8");
const rows = readme.split("\n").filter((line) => line.startsWith("| [`"));
const nameOf = (row) => row.match(/\[`([^`]+)`\]/)?.[1];
const linkOf = (row) => row.match(/\]\(([^)]+)\)/)?.[1];

test("the skills table has exactly one row for each new skill", () => {
  for (const skill of NEW_SKILLS) {
    const found = rows.filter((r) => nameOf(r) === skill);
    assert.equal(found.length, 1, `${skill} must appear exactly once in README.md (found ${found.length})`);
  }
});

test("each new row links to an existing SKILL.md in that skill's folder", () => {
  for (const skill of NEW_SKILLS) {
    const row = rows.find((r) => nameOf(r) === skill);
    const link = linkOf(row);
    assert.equal(link, `${skill}/SKILL.md`, `${skill} row links to ${link}`);
    assert.ok(existsSync(path.join(agentSkillsDir, link)), `${link} does not exist`);
  }
});

test("the engine row is still present and unchanged in name", () => {
  assert.ok(rows.some((r) => nameOf(r) === "dapr-docs-translation"));
});
