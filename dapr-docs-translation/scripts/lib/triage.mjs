// Triage of verify failures: what a script can fix, what has to be translated again, and what a person should look at.
// The rules read the checker's own messages, so a document is judged by what the checker found, not by a second opinion.
// Node built-ins only.

export const TRIAGE_CLASSES = ["retranslate", "review", "auto"];
const RANK = { retranslate: 2, review: 1, auto: 0 };

const counts = (message) => {
  const m = /\((\d+) vs (\d+)\b/.exec(message) ?? /count (\d+) vs (\d+)/.exec(message);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/**
 * One checker failure {check, message} → { class, why }.
 *   auto         fix-punctuation repairs it deterministically
 *   retranslate  the translation lost or gained structure (headings, tables, blocks, links, many code spans): it no longer
 *                matches this source, and patching it by script would be guessing
 *   review       same shape, different content (a changed code block, link target or span): either a deliberate edit or an
 *                error, which only a reader can tell
 */
export function judgeFailure({ check, message }) {
  const c = counts(message);
  switch (check) {
    case "cjk-punctuation":
      return { class: "auto", why: "ASCII punctuation next to CJK text" };
    case "headings":
      return { class: "retranslate", why: `heading structure differs (${c ? `${c[0]} vs ${c[1]}` : "?"})` };
    case "tables":
      return { class: "retranslate", why: "table shape differs" };
    case "code-fence":
      return c ? { class: "retranslate", why: `fenced block count ${c[0]} vs ${c[1]}` } : { class: "review", why: "a fenced block differs from the source" };
    case "links":
      return c && c[0] !== c[1] ? { class: "retranslate", why: `link count ${c[0]} vs ${c[1]}` } : { class: "review", why: "a link target differs from the source" };
    case "inline-code":
      return c && Math.abs(c[0] - c[1]) > Math.max(2, Math.round(Math.max(c[0], c[1]) * 0.1))
        ? { class: "retranslate", why: `inline code span count ${c[0]} vs ${c[1]}` }
        : { class: "review", why: "an inline code span differs from the source" };
    default:
      return { class: "review", why: `${check}: ${message}`.slice(0, 120) };
  }
}

/** verify.hard = [{doc, failures:[{check, message}]}] → [{doc, class, reasons:[{check, class, why}]}], worst class first. */
export function triage(hard) {
  const docs = hard.map(({ doc, failures }) => {
    const reasons = failures.map((f) => ({ check: f.check, ...judgeFailure(f) }));
    const cls = reasons.reduce((worst, r) => (RANK[r.class] > RANK[worst] ? r.class : worst), "auto");
    return { doc, class: cls, reasons };
  });
  return docs.sort((a, b) => RANK[b.class] - RANK[a.class] || a.doc.localeCompare(b.doc));
}
