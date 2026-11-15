// Minimal YAML-subset parser (Node built-ins only), enough for `profile.yaml`:
// block maps, block lists (also at the parent key's indent), `- key: v` list-of-maps, flow `[a, b]` / `{k: v}`,
// quoted scalars, `>`/`|` block scalars, comments, flow collections that span several lines. No anchors, tags or multi-document streams.
// Throws `Error("yaml: line N: ...")` on anything it does not understand instead of guessing.

const indentOf = (s) => s.match(/^ */)[0].length;

function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      // a quote only opens a string at the start of a token, so `don't` stays plain text
      if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function plainScalar(s) {
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function quoted(s, n) {
  if (s[0] === '"') {
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`yaml: line ${n}: bad double-quoted string ${s}`);
    }
  }
  return s.slice(1, -1).replaceAll("''", "'");
}

function parseFlow(s, n) {
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i += 1;
  };
  const value = () => {
    ws();
    if (s[i] === "[") {
      i += 1;
      const out = [];
      ws();
      while (s[i] !== "]") {
        out.push(value());
        ws();
        if (s[i] === ",") i += 1;
        else if (s[i] !== "]") throw new Error(`yaml: line ${n}: bad flow list near "${s.slice(i, i + 12)}"`);
        ws();
      }
      i += 1;
      return out;
    }
    if (s[i] === "{") {
      i += 1;
      const out = {};
      ws();
      while (s[i] !== "}") {
        const key = scalar(true);
        ws();
        if (s[i] !== ":") throw new Error(`yaml: line ${n}: flow map key without ":" near "${s.slice(i, i + 12)}"`);
        i += 1;
        out[key] = value();
        ws();
        if (s[i] === ",") i += 1;
        else if (s[i] !== "}") throw new Error(`yaml: line ${n}: bad flow map near "${s.slice(i, i + 12)}"`);
        ws();
      }
      i += 1;
      return out;
    }
    return scalar(false);
  };
  const scalar = (isKey) => {
    ws();
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1;
      while (j < s.length && s[j] !== q) j += q === '"' && s[j] === "\\" ? 2 : 1;
      if (j >= s.length) throw new Error(`yaml: line ${n}: unterminated string in flow collection`);
      const text = quoted(s.slice(i, j + 1), n);
      i = j + 1;
      return text;
    }
    const stop = isKey ? /[:,\]}]/ : /[,\]}]/;
    let j = i;
    while (j < s.length && !stop.test(s[j])) j += 1;
    const text = s.slice(i, j).trim();
    i = j;
    return isKey ? text : plainScalar(text);
  };
  const result = value();
  ws();
  if (i < s.length) throw new Error(`yaml: line ${n}: trailing text after flow collection`);
  return result;
}

function inline(s, n) {
  if (s.startsWith("[") || s.startsWith("{")) return parseFlow(s, n);
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0];
    if (s.length < 2 || s[s.length - 1] !== q) throw new Error(`yaml: line ${n}: unterminated string`);
    return quoted(s, n);
  }
  return plainScalar(s);
}

// `key: rest` where key is plain or quoted. Returns null when the text is not a map entry.
function splitEntry(text) {
  let m = text.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*)|)$/);
  if (m) return { key: quoted(m[1], 0), rest: m[2] ?? "" };
  if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"') || text.startsWith("'")) return null;
  m = text.match(/^(.*?):(?:\s+(.*)|)$/);
  if (!m || m[1] === "") return null;
  return { key: m[1].trim(), rest: m[2] ?? "" };
}

export function parseYaml(source) {
  const raw = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const skip = () => {
    while (i < raw.length && (raw[i].trim() === "" || raw[i].trim().startsWith("#"))) i += 1;
  };

  function blockScalar(header, parentIndent) {
    const folded = header[0] === ">";
    const chomp = header[1] ?? "";
    const body = [];
    let blockIndent = null;
    while (i < raw.length) {
      const line = raw[i];
      if (line.trim() === "") {
        body.push("");
        i += 1;
        continue;
      }
      const ind = indentOf(line);
      if (ind <= parentIndent) break;
      blockIndent ??= ind;
      if (ind < blockIndent) break;
      body.push(line.slice(blockIndent));
      i += 1;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    let text = body.join("\n");
    if (folded) {
      // folding: single newlines become spaces, each blank line becomes one newline
      text = "";
      body.forEach((line, k) => {
        if (k === 0) text = line;
        else if (line === "") text += "\n";
        else if (body[k - 1] === "") text += line;
        else text += ` ${line}`;
      });
    }
    if (chomp !== "-") text += "\n";
    return text;
  }

  // `[a,\n b]` / `{a: 1,\n b: 2}`: pull in following lines until the brackets balance
  function completeFlow(text) {
    if (!text.startsWith("[") && !text.startsWith("{")) return text;
    const depth = (t) => {
      let d = 0;
      let q = null;
      for (let k = 0; k < t.length; k += 1) {
        const c = t[k];
        if (q) {
          if (c === "\\" && q === '"') k += 1;
          else if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === "[" || c === "{") d += 1;
        else if (c === "]" || c === "}") d -= 1;
      }
      return d;
    };
    let out = text;
    while (depth(out) > 0 && i < raw.length) {
      out += ` ${stripComment(raw[i]).trim()}`;
      i += 1;
    }
    return out;
  }

  function entryValue(rest, indent, n) {
    if (/^[>|][+-]?$/.test(rest)) return blockScalar(rest, indent);
    if (rest !== "") return inline(completeFlow(rest), n);
    skip();
    if (i >= raw.length) return null;
    const next = indentOf(raw[i]);
    const nextText = stripComment(raw[i]).trim();
    if (next > indent) return node(next);
    if (next === indent && (nextText === "-" || nextText.startsWith("- "))) return list(indent); // list at the key's own indent
    return null;
  }

  function map(indent) {
    const out = {};
    for (;;) {
      skip();
      if (i >= raw.length) break;
      const ind = indentOf(raw[i]);
      if (ind < indent) break;
      const n = i + 1;
      if (ind > indent) throw new Error(`yaml: line ${n}: unexpected indentation`);
      const text = stripComment(raw[i]).trim();
      if (text === "-" || text.startsWith("- ")) break;
      const entry = splitEntry(text);
      if (!entry) throw new Error(`yaml: line ${n}: expected "key: value", got "${text}"`);
      i += 1;
      out[entry.key] = entryValue(entry.rest, indent, n);
    }
    return out;
  }

  function list(indent) {
    const out = [];
    for (;;) {
      skip();
      if (i >= raw.length) break;
      const ind = indentOf(raw[i]);
      const text = stripComment(raw[i]).trim();
      if (ind !== indent || !(text === "-" || text.startsWith("- "))) break;
      const n = i + 1;
      const content = text.slice(1).trim();
      if (content === "") {
        i += 1;
        skip();
        out.push(i < raw.length && indentOf(raw[i]) > indent ? node(indentOf(raw[i])) : null);
      } else if (splitEntry(content)) {
        // `- key: v` opens a map whose column is where the key starts; rewrite the line so map() sees it at that column
        const offset = raw[i].indexOf(content, raw[i].indexOf("-") + 1);
        raw[i] = " ".repeat(offset) + raw[i].slice(offset);
        out.push(map(offset));
      } else {
        i += 1;
        out.push(/^[>|][+-]?$/.test(content) ? blockScalar(content, indent) : inline(completeFlow(content), n));
      }
    }
    return out;
  }

  function node(indent) {
    skip();
    if (i >= raw.length) return null;
    const text = stripComment(raw[i]).trim();
    if (text === "-" || text.startsWith("- ")) return list(indentOf(raw[i]));
    if (splitEntry(text)) return map(indentOf(raw[i]));
    i += 1;
    return inline(text, i);
  }

  skip();
  const result = i >= raw.length ? {} : node(indentOf(raw[i]));
  skip();
  if (i < raw.length) throw new Error(`yaml: line ${i + 1}: unexpected content after the document`);
  return result;
}
