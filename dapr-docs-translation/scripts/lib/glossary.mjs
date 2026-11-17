// Glossary maintenance (references/glossary-and-style.md §1, §3): admit term candidates returned by translation jobs.
// Pure functions here; tr.mjs does the file I/O.
//
// Quality gate, in order, for a candidate that is not already in the glossary:
//   1. screen   — reject what is not a term: identifiers, document titles, generic words, sentence fragments, wording that
//                 is not in the source or not used in the translation (see screenCandidate);
//   2. collide  — refuse a rendering that already stands for a different source term;
//   3. stage    — the first sighting only goes to the pending list (glossary/pending.json); a candidate becomes a glossary
//                 term when `promoteAfter` documents agree: either they report it again, or they use the same rendering
//                 ("confirmation by use": the source has the term and the translation has the rendering).
// A preferred translation is never changed by a merge; locked and human-origin entries are never touched; a different
// translation is recorded as a conflict for a human to settle.
import { proseOf, slugOf, termRegExp } from "./jobs.mjs";

export const emptyGlossary = () => ({ schema: 1, version: 0, updatedAt: null, doNotTranslate: [], terms: [] });
export const emptyPending = () => ({ schema: 1, entries: [] });
export const DEFAULT_PROMOTE_AFTER = 2;

/** Ops that change glossary.json (and therefore bump its version). The others only touch pending.json or the log. */
export const GLOSSARY_OPS = new Set(["add", "promote", "bump", "conflict"]);

// Words every technical document has: they have no site-specific rendering to keep consistent (glossary-and-style.md §2).
const GENERIC = new Set(`file command variable option setting value item name type list user data page text example note step
  section guide overview document documentation feature service system error message request response default parameter key
  field table row column button link image output input version number string object array function method class module package
  folder directory path url address code script tool tools result action event task status state mode level group label title
  description summary reference note warning tip
  not and or the of to in on for with is are be by from as at it this that if when then than so but also only all any each more most do does can will should must`.split(/\s+/));

const normalise = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// plural → singular stems to try: files → file, boxes → box, bus stays bus
const stems = (w) => [...new Set([w, w.replace(/s$/, ""), w.replace(/es$/, "")])];
const occurs = (text, word) => stems(word.toLowerCase()).some((f) => f && termRegExp(f).test(text));

/** The document title: frontmatter `title`, else the first level-1 heading. */
export function docTitleOf(sourceText) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(sourceText ?? "");
  const t = fm && /^title:\s*(.+)$/m.exec(fm[1]);
  if (t) return t[1].trim().replace(/^["']|["']$/g, "");
  const h = /^#\s+(.+)$/m.exec(sourceText ?? "");
  return h ? h[1].trim() : null;
}

/**
 * Why a candidate is not a glossary term, or null if it passes.
 * ctx: { ignore:Set<string>, source?:string, translation?:string, title?:string }; the text checks are skipped when the text is unknown.
 */
export function screenCandidate(c, { ignore = new Set(), source, translation, title } = {}) {
  const word = String(c.source ?? "").trim();
  const dnt = Boolean(c.doNotTranslate);
  const target = String(c.target ?? "").trim();
  if (!word || (!dnt && !target)) return "empty";
  if (/[/\\_`@]|::|^--|\.\w{1,5}$/.test(word) || (/^[a-z]+[A-Z]/.test(word) && !/\s/.test(word))) return "identifier: looks like a path, flag or code symbol";
  if (/[→!?:&+=|<>{}[\]()]/.test(word)) return "symbol: a UI path, label or sentence, not a term";
  if (word.split(/\s+/).length > 4 || word.length > 40) return "too-long: a sentence fragment, not a term";
  if (word.length < 3 && word !== word.toUpperCase()) return "too-short";
  if (!/\s/.test(word)) {
    if (stems(word.toLowerCase()).some((k) => GENERIC.has(k) || ignore.has(k))) return "generic: an ordinary word with no site-specific rendering";
  } else {
    const words = word.toLowerCase().split(/\s+/);
    if (ignore.has(word.toLowerCase()) || words.every((w) => stems(w).some((k) => GENERIC.has(k)))) return "generic: made only of ordinary words";
    // a name of a page, not a term of the product ("Free Tiers Guide", "Quick Reference")
    if (/^(guide|reference|docs|documentation|overview|index)$/.test(words.at(-1)) && words.length > 1) return "title: looks like a document name";
  }
  if (title && normalise(title) === normalise(word)) return "title: the document's own title is not a term";
  if (!dnt && target.toLowerCase() === word.toLowerCase()) return "untranslated: the rendering equals the source (use do-not-translate)";
  if (!dnt && target.length > 30) return "too-long: the rendering is a phrase, not a term";
  if (source && !occurs(proseOf(source), word)) return "not-in-source: the term does not occur in the document's prose";
  if (translation) {
    if (dnt ? !translation.includes(word) : !translation.includes(target)) return "not-used: the translation does not contain it";
  }
  return null;
}

/**
 * candidates: [{doc, source, target?, note?, doNotTranslate?}] in the order the documents were finished.
 * opts: { run, pending, promoteAfter = 1, ignore = [], contextOf(doc) → {source, translation, title} | null, docs = [] }
 * `docs` are documents to run the confirmation-by-use pass on even though they reported no candidates.
 * Returns { glossary, pending, changes, rejected, versionBumps } — `changes` are changes.jsonl rows (without ts/run);
 * `versionBumps` is the number of documents that changed glossary.json (one version step per document).
 */
export function mergeCandidates(glossary, candidates, { run, pending, promoteAfter = 1, ignore = [], contextOf = () => null, docs = [] } = {}) {
  const g = structuredClone(glossary ?? emptyGlossary());
  g.terms ??= [];
  g.doNotTranslate ??= [];
  const p = structuredClone(pending ?? emptyPending());
  p.entries ??= [];
  const ign = new Set(ignore.map((x) => String(x).toLowerCase()));
  const changes = [];
  const rejected = [];
  const byDoc = new Map();
  for (const c of candidates) {
    if (!c?.source) continue;
    if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
    byDoc.get(c.doc).push(c);
  }
  for (const d of docs) if (!byDoc.has(d)) byDoc.set(d, []);
  let version = g.version ?? 0;

  for (const [doc, list] of byDoc) {
    const rows = [];
    const ctx = contextOf(doc) ?? {};
    const seen = { doc, run };

    const addTerm = (e, op) => {
      g.terms.push({
        id: e.id, source: e.source, target: e.target, alt: [], note: e.note ?? "", origin: "auto", locked: false,
        confidence: e.docs && e.docs.length >= 3 ? "high" : "medium", occurrences: e.docs ? e.docs.length : 1,
        firstSeen: e.firstSeen ?? seen, lastSeen: seen, conflicts: [],
      });
      rows.push({ op, id: e.id, target: e.target });
    };

    // a staged entry that reached the threshold: becomes a glossary term (or do-not-translate name)
    const promote = (e) => {
      p.entries = p.entries.filter((x) => x !== e);
      if (e.kind === "doNotTranslate") {
        if (!g.doNotTranslate.some((t) => t.term.toLowerCase() === e.source.toLowerCase())) {
          g.doNotTranslate.push({ term: e.source, note: e.note ?? "", origin: "auto", locked: false });
          rows.push({ op: "promote", id: e.id, kind: "doNotTranslate", docs: e.docs.length });
        }
        return;
      }
      const clash = g.terms.find((x) => x.id !== e.id && x.target === e.target);
      if (clash) {
        rows.push({ op: "collision", id: e.id, target: e.target, with: clash.id });
        return;
      }
      addTerm(e, "promote");
      rows[rows.length - 1].docs = e.docs.length;
      rows[rows.length - 1].docNames = [...e.docs]; // the documents that evidenced it: they are tracked for drift too
      // other renderings of the same word that were also pending are now conflicts of the winner
      const term = g.terms.find((x) => x.id === e.id);
      for (const other of p.entries.filter((x) => x.id === e.id && x.kind === "term")) {
        term.conflicts.push({ target: other.target, doc: other.docs[0], run });
        rows.push({ op: "conflict", id: e.id, target: other.target });
      }
      p.entries = p.entries.filter((x) => !(x.id === e.id && x.kind === "term"));
    };

    for (const c of list) {
      const id = slugOf(c.source);
      const dnt = Boolean(c.doNotTranslate);
      if (!dnt && !c.target) continue;

      // already in the glossary: reuse or conflict, never replace
      if (dnt) {
        if (g.doNotTranslate.some((t) => t.term.toLowerCase() === c.source.toLowerCase())) continue;
      } else {
        const t = g.terms.find((x) => x.id === id);
        if (t) {
          if (t.target === c.target) {
            t.occurrences = (t.occurrences ?? 0) + 1;
            t.lastSeen = seen;
            if (t.occurrences >= 3 && t.confidence !== "high") t.confidence = "high";
            rows.push({ op: "bump", id, occurrences: t.occurrences });
          } else {
            t.conflicts ??= [];
            if (!t.conflicts.some((x) => x.target === c.target)) {
              t.conflicts.push({ target: c.target, doc, run });
              rows.push({ op: "conflict", id, target: c.target });
            }
          }
          continue;
        }
      }

      const reason = screenCandidate(c, { ignore: ign, ...ctx });
      if (reason) {
        rows.push({ op: "reject", id, target: c.target ?? null, reason });
        rejected.push({ doc, source: c.source, target: c.target ?? null, reason });
        continue;
      }
      if (!dnt) {
        // the same rendering already stands for a different source term: adding it would make two words indistinguishable
        const clash = g.terms.find((x) => x.id !== id && x.target === c.target);
        if (clash) {
          rows.push({ op: "collision", id, target: c.target, with: clash.id });
          continue;
        }
      }
      const entry = { id, source: c.source, target: dnt ? null : c.target, kind: dnt ? "doNotTranslate" : "term", note: c.note ?? "", docs: [doc], firstSeen: seen, lastSeen: seen };
      if (promoteAfter <= 1) {
        if (dnt) {
          g.doNotTranslate.push({ term: c.source, note: c.note ?? "", origin: "auto", locked: false });
          rows.push({ op: "add", id, kind: "doNotTranslate" });
        } else addTerm(entry, "add");
        continue;
      }
      // stage: first sighting waits for a second document to agree
      const same = p.entries.find((x) => x.id === id && x.kind === entry.kind && x.target === entry.target);
      if (!same) {
        p.entries.push(entry);
        rows.push({ op: "stage", id, target: entry.target });
      } else if (!same.docs.includes(doc)) {
        same.docs.push(doc);
        same.lastSeen = seen;
        rows.push({ op: "confirm", id, target: same.target, docs: same.docs.length });
        if (same.docs.length >= promoteAfter) promote(same);
      }
    }

    // confirmation by use: this document has a pending term in its source and uses the pending rendering in its translation
    if (promoteAfter > 1 && ctx.source && ctx.translation) {
      const prose = proseOf(ctx.source);
      for (const e of [...p.entries]) {
        if (e.docs.includes(doc) || !termRegExp(e.source).test(prose)) continue;
        const used = e.kind === "doNotTranslate" ? ctx.translation.includes(e.source) : ctx.translation.includes(e.target);
        if (!used) continue;
        e.docs.push(doc);
        e.lastSeen = seen;
        rows.push({ op: "confirm", id: e.id, target: e.target, docs: e.docs.length, by: "use" });
        if (e.docs.length >= promoteAfter) promote(e);
      }
    }

    if (rows.some((r) => GLOSSARY_OPS.has(r.op))) version += 1;
    for (const r of rows) changes.push({ ...r, version, doc });
  }
  g.terms.sort((a, b) => a.id.localeCompare(b.id));
  g.version = version;
  return { glossary: g, pending: p, changes, rejected, versionBumps: version - (glossary?.version ?? 0) };
}

// ------------------------------------------------------------------------------------------------ audit of an existing glossary

/**
 * Re-check the entries a run added (not human, not locked) with the same gate new candidates pass, plus real evidence:
 *   - static screen fails (generic word, identifier, …)            → remove (it was never a term);
 *   - origin "auto" used (source has the term AND translation has the rendering) in fewer than `minDocs` of the
 *     translated documents                                          → demote to the pending list, keeping its evidence;
 *   - everything else stays. Collisions and inconsistent use among the kept terms are reported, not changed.
 * docs: [{doc, source, translation}] — the finished translations. Returns { keep, demote, remove, notes }.
 */
export function auditGlossary(glossary, { docs = [], minDocs = DEFAULT_PROMOTE_AFTER, ignore = [] } = {}) {
  const ign = new Set(ignore.map((x) => String(x).toLowerCase()));
  const keep = [];
  const demote = [];
  const remove = [];
  const prose = docs.map((d) => ({ ...d, prose: proseOf(d.source) }));
  const evidenceOf = (term) => {
    const present = prose.filter((d) => occurs(d.prose, term.source));
    const using = present.filter((d) => d.translation.includes(term.target));
    return { present: present.map((d) => d.doc), using: using.map((d) => d.doc), inconsistent: present.filter((d) => !d.translation.includes(term.target)).map((d) => d.doc) };
  };
  for (const t of glossary.terms ?? []) {
    const ev = evidenceOf(t);
    if (t.origin === "human" || t.locked) {
      keep.push({ id: t.id, target: t.target, why: "human or locked", ...ev });
      continue;
    }
    // reverted to English (applyRevert): the rendering is the source word, held by a do-not-translate entry. Not a term to judge.
    if (isKeptInEnglish(t, glossary)) {
      keep.push({ id: t.id, target: t.target, why: "kept in English (do-not-translate)", present: ev.present, using: ev.using, inconsistent: [] });
      continue;
    }
    const reason = screenCandidate({ source: t.source, target: t.target }, { ignore: ign });
    if (reason) {
      remove.push({ id: t.id, source: t.source, target: t.target, kind: "term", reason, ...ev });
      continue;
    }
    if (t.origin === "auto" && ev.using.length < minDocs) {
      demote.push({ id: t.id, source: t.source, target: t.target, kind: "term", note: t.note ?? "", reason: `evidence: rendering used in ${ev.using.length} of ${ev.present.length} translated document(s) that contain the term; ${minDocs} needed`, firstSeen: t.firstSeen, ...ev });
      continue;
    }
    keep.push({ id: t.id, target: t.target, why: t.origin === "auto" ? `used in ${ev.using.length} documents` : `origin ${t.origin}`, ...ev });
  }
  for (const n of glossary.doNotTranslate ?? []) {
    if (n.origin === "human" || n.locked) continue;
    const reason = screenCandidate({ source: n.term, doNotTranslate: true }, { ignore: ign });
    if (reason) remove.push({ id: slugOf(n.term), source: n.term, kind: "doNotTranslate", reason });
  }
  const notes = [];
  const gone = new Set([...demote, ...remove].map((x) => x.id));
  const byTarget = new Map();
  for (const t of (glossary.terms ?? []).filter((x) => !gone.has(x.id))) {
    if (!byTarget.has(t.target)) byTarget.set(t.target, []);
    byTarget.get(t.target).push(t.id);
  }
  for (const [target, ids] of byTarget) if (ids.length > 1) notes.push({ kind: "collision", target, ids });
  for (const k of keep) if (k.inconsistent?.length) notes.push({ kind: "inconsistent", id: k.id, target: k.target, docs: k.inconsistent });
  return { keep, demote, remove, notes };
}

/** A term whose preferred translation is its source word and that a do-not-translate entry holds: kept in English on purpose. */
export function isKeptInEnglish(term, glossary) {
  const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  return Boolean(term.source) && same(term.target, term.source) && (glossary?.doNotTranslate ?? []).some((n) => same(n.term, term.source));
}

/**
 * Decide terms by hand (`tr.mjs glossary revert`). Pure: the caller does the file I/O.
 *   to "source": the term keeps its English form: target = source, and a do-not-translate entry holds the word so later
 *                translations keep it as written. Finished translations are not changed (their recorded renderings may drift later).
 *   to "remove": the term row is deleted.
 * Either way, pending candidates of the same term id are withdrawn so "confirmation by use" cannot bring the old rendering back.
 * Locked and human-origin terms are skipped and reported; an unknown id is reported as not-found; a term already in the target state is "already".
 * ids: term ids (slugs). Returns { glossary, pending, changes, outcomes, withdrawn, versionBumps }; `changes` are changes.jsonl rows.
 */
export function applyRevert(glossary, pending, { ids = [], to, reason = "" } = {}) {
  if (!["source", "remove"].includes(to)) throw new Error(`revert: to must be "source" or "remove" (got "${to}")`);
  const g = structuredClone(glossary ?? emptyGlossary());
  g.terms ??= [];
  g.doNotTranslate ??= [];
  const p = structuredClone(pending ?? emptyPending());
  p.entries ??= [];
  const changes = [];
  const outcomes = [];
  const withdrawn = [];
  const why = String(reason ?? "").trim();
  for (const id of ids) {
    const t = g.terms.find((x) => x.id === id);
    if (!t) {
      outcomes.push({ id, status: "not-found" });
      continue;
    }
    if (t.locked || t.origin === "human") {
      outcomes.push({ id, status: "skipped", why: t.locked ? "locked" : "human", source: t.source, target: t.target });
      continue;
    }
    const names = g.doNotTranslate.findIndex((n) => String(n.term).toLowerCase() === String(t.source).toLowerCase());
    if (to === "source") {
      if (isKeptInEnglish(t, g)) {
        outcomes.push({ id, status: "already", source: t.source, target: t.target });
        continue;
      }
      const from = t.target;
      t.target = t.source;
      t.note = [t.note, why ? `kept in English: ${why}` : "kept in English"].filter(Boolean).join("; ");
      if (names < 0) g.doNotTranslate.push({ term: t.source, note: why ? `reverted: ${why}` : "reverted to English", origin: "human", locked: false });
      changes.push({ op: "revert", id, kind: "term", from, target: t.source, to: "source", doNotTranslate: names < 0 ? "added" : "already", reason: why || null });
      outcomes.push({ id, status: "reverted", source: t.source, from, target: t.source, doNotTranslate: names < 0 ? "added" : "already" });
    } else {
      g.terms = g.terms.filter((x) => x !== t);
      changes.push({ op: "revert", id, kind: "term", from: t.target, target: null, to: "removed", reason: why || null });
      outcomes.push({ id, status: "removed", source: t.source, from: t.target });
    }
    // candidates still pending for this term id would otherwise be promoted back by use
    const staged = p.entries.filter((e) => e.id === id && e.kind === "term");
    if (staged.length) {
      p.entries = p.entries.filter((e) => !(e.id === id && e.kind === "term"));
      for (const e of staged) {
        withdrawn.push({ id, target: e.target, docs: e.docs.length });
        changes.push({ op: "revert", id, kind: "pending", from: e.target, target: null, to: "withdrawn", reason: why || null });
      }
    }
  }
  const touched = changes.length > 0;
  if (touched) g.version = (g.version ?? 0) + 1;
  for (const c of changes) c.version = g.version;
  return { glossary: g, pending: p, changes, outcomes, withdrawn, versionBumps: touched ? 1 : 0 };
}

/** Apply an audit: drop removed and demoted entries from the glossary, stage the demoted ones, one version step. */
export function applyAudit(glossary, pending, audit, { run }) {
  const g = structuredClone(glossary);
  const p = structuredClone(pending ?? emptyPending());
  p.entries ??= [];
  const changes = [];
  const gone = new Set([...audit.demote, ...audit.remove].filter((x) => x.kind === "term").map((x) => x.id));
  g.terms = (g.terms ?? []).filter((t) => !gone.has(t.id));
  const goneNames = new Set(audit.remove.filter((x) => x.kind === "doNotTranslate").map((x) => x.source.toLowerCase()));
  g.doNotTranslate = (g.doNotTranslate ?? []).filter((n) => !goneNames.has(n.term.toLowerCase()));
  for (const r of audit.remove) changes.push({ op: "demote", id: r.id, target: r.target ?? null, kind: r.kind, to: "removed", reason: r.reason });
  for (const d of audit.demote) {
    let e = p.entries.find((x) => x.id === d.id && x.kind === "term" && x.target === d.target);
    if (!e) {
      e = { id: d.id, source: d.source, target: d.target, kind: "term", note: d.note, docs: [], firstSeen: d.firstSeen ?? { run }, lastSeen: { run } };
      p.entries.push(e);
    }
    for (const doc of d.using ?? []) if (!e.docs.includes(doc)) e.docs.push(doc);
    changes.push({ op: "demote", id: d.id, target: d.target, kind: "term", to: "pending", reason: d.reason, docs: e.docs.length });
  }
  const touched = changes.length > 0;
  if (touched) g.version = (g.version ?? 0) + 1;
  for (const c of changes) c.version = g.version;
  return { glossary: g, pending: p, changes, versionBumps: touched ? 1 : 0 };
}
