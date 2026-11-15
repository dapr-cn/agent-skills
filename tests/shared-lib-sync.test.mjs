// Every skill carries its own copy of the shared modules (design D1). The copies must be byte-identical, so a change made in
// one copy and not the others fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { agentSkillsDir } from "./_fixtures/mono.mjs";

// The engine keeps its own, older modules and is not part of the shared set.
const ENGINE = "dapr-docs-translation";

const skills = readdirSync(agentSkillsDir).filter(
  (name) => name.startsWith("dapr-docs-") && name !== ENGINE && existsSync(path.join(agentSkillsDir, name, "scripts", "lib")),
);

function copiesOf(file) {
  return skills
    .map((skill) => ({ skill, abs: path.join(agentSkillsDir, skill, "scripts", "lib", file) }))
    .filter((c) => existsSync(c.abs));
}

test("the four new skills exist and each has the shared yaml, config and git copies", () => {
  for (const skill of ["dapr-docs-translate-incremental", "dapr-docs-translation-verify", "dapr-docs-version-bootstrap", "dapr-docs-upstream-pr"]) {
    for (const file of ["yaml.mjs", "config.mjs", "git.mjs"]) {
      assert.ok(existsSync(path.join(agentSkillsDir, skill, "scripts", "lib", file)), `${skill}/scripts/lib/${file} is missing`);
    }
  }
});

test("copies of each shared module are byte-identical across skills", () => {
  const files = new Set();
  for (const skill of skills) for (const f of readdirSync(path.join(agentSkillsDir, skill, "scripts", "lib"))) files.add(f);
  for (const file of files) {
    const copies = copiesOf(file);
    if (copies.length < 2) continue;
    const reference = readFileSync(copies[0].abs, "utf8");
    for (const c of copies.slice(1)) {
      assert.equal(readFileSync(c.abs, "utf8"), reference, `${c.skill}/scripts/lib/${file} differs from ${copies[0].skill}/scripts/lib/${file}`);
    }
  }
});

test("guard.mjs is carried only by the skills that run confirmed steps", () => {
  const holders = copiesOf("guard.mjs").map((c) => c.skill).sort();
  assert.deepEqual(holders, ["dapr-docs-upstream-pr", "dapr-docs-version-bootstrap"]);
});
