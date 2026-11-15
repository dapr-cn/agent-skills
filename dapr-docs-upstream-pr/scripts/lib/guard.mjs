// Confirmation guard for public or irreversible steps. Node built-ins only.
// Copied verbatim into every skill's scripts/lib/ that runs such steps (tests/shared-lib-sync.test.mjs keeps the copies identical).
// A plan hash binds a confirmation to one step of the plan as it is right now. The guard reads no environment variable,
// ledger, config or earlier output: the only confirmation is the --confirm value passed to this call.
import { createHash } from "node:crypto";

/** Deterministic JSON: keys sorted at every level, so the same step always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The hash of one planned step. `spec` must contain the step id, the target remote and branch, the target commit and
 * the exact command. Any change to these changes the hash, so a confirmation for one step never fits another.
 */
export function planHash(spec) {
  return createHash("sha256").update(canonical(spec)).digest("hex").slice(0, 16);
}

/**
 * Decides whether a `--confirm` value may run the step.
 * code 0: confirmed. code 2: no confirmation given. code 3: a confirmation was given but it does not match the current plan.
 */
export function checkConfirm({ stepId, expected, given }) {
  if (given === undefined || given === null || given === "") {
    return { ok: false, code: 2, reason: `no --confirm value for step ${stepId}; nothing was executed` };
  }
  if (given !== expected) {
    return {
      ok: false,
      code: 3,
      reason: `--confirm ${given} does not match the current plan hash ${expected} for step ${stepId}; the repository state or the plan has changed, so review the new plan and confirm its hash`,
    };
  }
  return { ok: true, code: 0, reason: "confirmed" };
}
