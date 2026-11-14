#!/usr/bin/env node
// statectl — durable-state helper for the dapr-docs-translation skill. Node built-ins only. (`tr.mjs finalize` is the
// friendlier front end for one finished document; this is the low-level tool.)
//
//   statectl.mjs lock acquire  --dir <state-dir> --run <runId> [--max-minutes 270]
//   statectl.mjs lock release  --dir <state-dir> --run <runId>
//   statectl.mjs ledger append --dir <state-dir> --json '<object>'
//   statectl.mjs ledger replay --dir <state-dir>
//   statectl.mjs snapshot load  --dir <state-dir>
//   statectl.mjs snapshot write --dir <state-dir> --run <runId> --file <new-snapshot.json> [--keep 14]
//   statectl.mjs doc finalize   --dir <state-dir> --run <runId> --doc <doc> --source <source-file> --translation <translation-file>
//                               [--status done|done_flagged] [--flags '["a","b"]'] [--attempts 1]
//                               [--glossary-version N] [--glossary-sha256 H] [--source-revision R] [--locale L]
//                               [--repo <dir>]            translationPath is recorded relative to this (default: cwd)
//                               [--model M] [--retries N] [--seconds S] [--tokens-in N] [--tokens-out N]
//                               [--term-targets '{"id":"target"}'] [--keep-base false]
//     Hashes both files itself (never trust a hash typed by hand), refuses identical hashes, appends `doc_done`
//     to the ledger, updates the snapshot atomically with a backup, and keeps the translated source in <state-dir>/base/.
//
// Exit codes: 0 ok, 2 usage/invalid input, 3 lock busy, 4 nothing recoverable.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { acquireLock, appendLedger, finalizeDoc, releaseLock, replayLedger, snapshotCandidates, validJson, writeSnapshot } from "./lib/state.mjs";

const [group, action, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith("--") || rest[i + 1] === undefined) usage(`bad argument near ${rest[i]}`);
  opt[rest[i].slice(2)] = rest[i + 1];
}

function usage(message) {
  console.error(`statectl: ${message}`);
  process.exit(2);
}
const need = (name) => opt[name] ?? usage(`missing --${name}`);
const num = (name) => (opt[name] === undefined ? undefined : Number.isFinite(Number(opt[name])) ? Number(opt[name]) : usage(`--${name} must be a number`));
const json = (name) => {
  if (opt[name] === undefined) return undefined;
  try {
    return JSON.parse(opt[name]);
  } catch {
    return usage(`--${name} must be valid JSON`);
  }
};
const dir = path.resolve(need("dir"));
mkdirSync(dir, { recursive: true });

if (group === "lock" && action === "acquire") {
  const r = acquireLock(dir, need("run"), Number(opt["max-minutes"] ?? 270));
  console.log(JSON.stringify(r));
  if (r.status === "busy") process.exit(3);
} else if (group === "lock" && action === "release") {
  console.log(JSON.stringify(releaseLock(dir, need("run"))));
} else if (group === "ledger" && action === "append") {
  let entry;
  try {
    entry = JSON.parse(need("json"));
  } catch (error) {
    usage(`--json is not valid JSON: ${error.message}`);
  }
  try {
    appendLedger(dir, entry);
  } catch (error) {
    usage(error.message);
  }
} else if (group === "ledger" && action === "replay") {
  console.log(JSON.stringify(replayLedger(path.join(dir, "ledger.jsonl")), null, 2));
} else if (group === "snapshot" && action === "load") {
  const hit = snapshotCandidates(dir).find(([, p]) => existsSync(p) && validJson(p));
  if (!hit) {
    console.error("statectl: no valid snapshot or backup");
    process.exit(4);
  }
  console.error(`source=${hit[0]}`);
  process.stdout.write(readFileSync(hit[1], "utf8"));
} else if (group === "snapshot" && action === "write") {
  const incoming = path.resolve(need("file"));
  if (!validJson(incoming)) usage(`${incoming} is not valid JSON; snapshot left untouched`);
  writeSnapshot(dir, need("run"), readFileSync(incoming, "utf8"), Number(opt.keep ?? 14));
  console.log(JSON.stringify({ status: "written" }));
} else if (group === "doc" && action === "finalize") {
  const tokensIn = num("tokens-in");
  const tokensOut = num("tokens-out");
  try {
    console.log(JSON.stringify(finalizeDoc({
      dir, run: need("run"), doc: need("doc"), sourceFile: need("source"), translationFile: need("translation"),
      status: opt.status, flags: json("flags"), attempts: num("attempts"), locale: opt.locale, repo: opt.repo,
      glossaryVersion: num("glossary-version"), glossarySha256: opt["glossary-sha256"], sourceRevision: opt["source-revision"],
      model: opt.model, retries: num("retries"), seconds: num("seconds"),
      tokens: tokensIn !== undefined || tokensOut !== undefined ? { in: tokensIn ?? 0, out: tokensOut ?? 0 } : undefined,
      termTargets: json("term-targets"), keepBase: opt["keep-base"] === "false" ? false : undefined,
    })));
  } catch (error) {
    usage(error.message);
  }
} else {
  usage("unknown command; see the header of this file");
}
