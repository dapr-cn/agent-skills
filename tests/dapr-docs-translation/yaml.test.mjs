import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { libUrl, skillDir } from "./helpers.mjs";

const { parseYaml } = await import(libUrl("yaml.mjs"));

test("scalars, comments and quoting", () => {
  const y = parseYaml(`
# leading comment
a: 1
b: "x # not a comment"   # but this is
c: 'it''s'
d: don't stop
e: ~
f: true
g: 1.5
h: "tab\\there"
`);
  assert.deepEqual(y, { a: 1, b: "x # not a comment", c: "it's", d: "don't stop", e: null, f: true, g: 1.5, h: "tab\there" });
});

test("flow collections, including ones that span lines", () => {
  const y = parseYaml(`
c: [1, "two", three]
d: { tier: 1, match: ["README.md", "docs/"] }
m: [x,
  "y, z",   # comment inside
  w]
n: { k: 1,
  j: [1,
 2] }
l:
  - [p,
    q]
`);
  assert.deepEqual(y.c, [1, "two", "three"]);
  assert.deepEqual(y.d, { tier: 1, match: ["README.md", "docs/"] });
  assert.deepEqual(y.m, ["x", "y, z", "w"]);
  assert.deepEqual(y.n, { k: 1, j: [1, 2] });
  assert.deepEqual(y.l, [["p", "q"]]);
});

test("block lists, lists of maps, and a list at the key's own indent", () => {
  const y = parseYaml(`
e:
  - one
  - { k: v }
  - name: n
    items:
      - p
      - q
f:
- same-1
- same-2
`);
  assert.equal(y.e[0], "one");
  assert.deepEqual(y.e[1], { k: "v" });
  assert.deepEqual(y.e[2], { name: "n", items: ["p", "q"] });
  assert.deepEqual(y.f, ["same-1", "same-2"]);
});

test("block scalars fold and keep lines", () => {
  const y = parseYaml(`
folded: >-
  one
  two

  three
literal: |
  keep
  lines
`);
  assert.equal(y.folded, "one two\nthree");
  assert.equal(y.literal, "keep\nlines\n");
});

test("nesting and empty documents", () => {
  assert.equal(parseYaml("j:\n  nested:\n    deep: true\n").j.nested.deep, true);
  assert.deepEqual(parseYaml(""), {});
  assert.deepEqual(parseYaml("# only a comment\n"), {});
});

test("malformed input throws instead of guessing", () => {
  assert.throws(() => parseYaml("a: 1\n  b: 2\n"), /indentation/);
  assert.throws(() => parseYaml("a: [1, 2\n"), /flow/);
  assert.throws(() => parseYaml('a: "unterminated\n'), /unterminated|string/);
  assert.throws(() => parseYaml("just text\nmore text\n"), /yaml/);
});

test("the shipped profile template parses with the expected shape", () => {
  const y = parseYaml(readFileSync(path.join(skillDir, "templates/profile.example.yaml"), "utf8"));
  assert.equal(y.schema, 1);
  assert.equal(y.locales["zh-CN"].cjk, true);
  assert.equal(y.sources.discovery.command.includes("{locale}"), true);
});
