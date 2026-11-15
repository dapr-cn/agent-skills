// Structure of every dapr-docs-* skill folder: SKILL.md frontmatter, and the import rule for the scripts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseYaml } from "../dapr-docs-translate-incremental/scripts/lib/yaml.mjs";
import { agentSkillsDir, tmpDir, write } from "./_fixtures/mono.mjs";

const NEW_SKILLS = ["dapr-docs-translate-incremental", "dapr-docs-translation-verify", "dapr-docs-version-bootstrap", "dapr-docs-upstream-pr"];
const skillFolders = readdirSync(agentSkillsDir).filter((n) => n.startsWith("dapr-docs-") && statSync(path.join(agentSkillsDir, n)).isDirectory());

/** The frontmatter of a SKILL.md as a parsed object. Throws when there is none. */
export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter");
  return parseYaml(m[1]);
}

/** Every module specifier a script imports (static `import ... from` and dynamic `import(...)`). */
export function importsOf(source) {
  const specs = [];
  for (const m of source.matchAll(/(?:import\s[^'"`;]*?from\s*|import\s*\(\s*|import\s+)(["'])([^"']+)\1/g)) specs.push(m[2]);
  return specs;
}

/** An import is allowed when it is a Node built-in (node:…) or a relative file. Anything else is a third-party dependency. */
export const isAllowedImport = (spec) => spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");

function scriptFiles(skill) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".mjs")) out.push(abs);
    }
  };
  const dir = path.join(agentSkillsDir, skill, "scripts");
  if (existsSync(dir)) walk(dir);
  return out;
}

test("every new skill folder exists", () => {
  for (const skill of NEW_SKILLS) assert.ok(skillFolders.includes(skill), `${skill} is missing`);
});

for (const skill of skillFolders) {
  test(`${skill}: SKILL.md exists, its name equals the folder, and its description says when to use it`, () => {
    const file = path.join(agentSkillsDir, skill, "SKILL.md");
    assert.ok(existsSync(file), `${skill}/SKILL.md is missing`);
    const fm = frontmatter(readFileSync(file, "utf8"));
    assert.equal(fm.name, skill);
    assert.equal(typeof fm.description, "string");
    assert.ok(fm.description.trim().length > 0, "description is empty");
    assert.match(fm.description, /\b(Use|use)\b|触发|用于|用/, "description must say when to use the skill");
  });
}

test("every script of the new skills imports only Node built-ins or relative files", () => {
  for (const skill of NEW_SKILLS) {
    for (const file of scriptFiles(skill)) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        assert.ok(isAllowedImport(spec), `${path.relative(agentSkillsDir, file)} imports "${spec}"`);
      }
    }
  }
});

test("the import rule rejects a third-party package in a fixture", () => {
  const fixture = write(path.join(tmpDir("dapr-imports-"), "bad.mjs"), "import yaml from 'js-yaml';\nexport default yaml;\n");
  const specs = importsOf(readFileSync(fixture, "utf8"));
  assert.deepEqual(specs, ["js-yaml"]);
  assert.equal(specs.every(isAllowedImport), false);
});

test("the import rule accepts built-ins, relative files and dynamic relative imports", () => {
  const source = "import fs from 'node:fs';\nimport { x } from './lib/x.mjs';\nconst y = await import('../y.mjs');\n";
  assert.deepEqual(importsOf(source), ["node:fs", "./lib/x.mjs", "../y.mjs"]);
  assert.equal(importsOf(source).every(isAllowedImport), true);
});
