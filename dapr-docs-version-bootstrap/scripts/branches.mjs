// Branch discovery for dapr-docs-version-bootstrap. Node built-ins only. Pure: the caller supplies the `git ls-remote --heads` text,
// so every rule here is testable without a network.
//   documentation branches:  v<major>.<minor>          (upstream dapr/docs)
//   translation branches:    v<major>.<minor>_content  (dapr/docs-zh)
// Anything else (for example the old new_content_v1.x names) is ignored.

export const DOCS_BRANCH = /^v(\d+)\.(\d+)$/;
export const CONTENT_BRANCH = /^v(\d+)\.(\d+)_content$/;

/** Parses `git ls-remote --heads` output into [{ name, sha }]. */
export function parseLsRemote(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref = ""] = line.split(/\s+/);
      return { sha, name: ref.replace(/^refs\/heads\//, "") };
    })
    .filter((b) => b.sha && b.name);
}

/** The numeric (major, minor) of a vX.Y string, so v1.2 sorts before v1.13. */
export function versionKey(version) {
  const m = String(version).match(/^v(\d+)\.(\d+)$/);
  if (!m) throw new Error(`not a version: ${version}`);
  return [Number(m[1]), Number(m[2])];
}

export function compareVersions(a, b) {
  const [ma, na] = versionKey(a);
  const [mb, nb] = versionKey(b);
  return ma - mb || na - nb;
}

export const sortVersions = (list) => [...new Set(list)].sort(compareVersions);

/** Splits branch names into documentation versions, translation versions (as vX.Y) and ignored names. */
export function classifyBranches(branches) {
  const docs = [];
  const content = [];
  const ignored = [];
  for (const b of branches) {
    if (DOCS_BRANCH.test(b.name)) docs.push(b.name);
    else if (CONTENT_BRANCH.test(b.name)) content.push(b.name.replace(/_content$/, ""));
    else ignored.push(b.name);
  }
  return { docs: sortVersions(docs), content: sortVersions(content), ignored };
}

/** The largest version below `target` that has a translation branch, or null. */
export function pickPrevious({ target, contentVersions }) {
  const lower = sortVersions(contentVersions).filter((v) => compareVersions(v, target) < 0);
  return lower.length ? lower[lower.length - 1] : null;
}

export const branchNamed = (branches, name) => branches.find((b) => b.name === name) ?? null;
