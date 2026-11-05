/**
 * Vim's search patterns as JavaScript regular expressions: magic by default (`\(` `\)` `\|` `\+` `\?` `\=` `\{n,m}`
 * are special, their bare forms literal), `\v` very magic (everything special, as in JavaScript), `\V` very nomagic
 * (only what follows a backslash), `\<` `\>` word edges, the character classes (`\s` `\d` `\w` `\a` `\l` `\u` `\x`
 * `\h`…), and smartcase unless `\c` / `\C` say otherwise.
 */
export function vimRegex(pattern: string, flags = "g", ignoreCase?: boolean): RegExp {
  let mode: "v" | "m" | "V" = "m";
  let caseFlag: boolean | undefined = ignoreCase;
  let out = "";
  const CLASSES: Record<string, string> = {
    s: "\\s",
    S: "\\S",
    d: "\\d",
    D: "\\D",
    w: "\\w",
    W: "\\W",
    a: "[A-Za-z]",
    A: "[^A-Za-z]",
    l: "[a-z]",
    L: "[^a-z]",
    u: "[A-Z]",
    U: "[^A-Z]",
    x: "[0-9A-Fa-f]",
    X: "[^0-9A-Fa-f]",
    o: "[0-7]",
    O: "[^0-7]",
    h: "[A-Za-z_]",
    H: "[^A-Za-z_]",
    t: "\\t",
    n: "\\n",
    e: "\\x1b",
  };
  const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

  /** `{n,m}` after its opening brace: `-` makes it lazy, as `\{-}` does in Vim. */
  const count = (from: number) => {
    let at = from;
    let lazy = false;
    if (pattern[at] === "-") {
      lazy = true;
      at++;
    }
    let body = "";
    while (at < pattern.length && pattern[at] !== "}" && !(pattern[at] === "\\" && pattern[at + 1] === "}"))
      body += pattern[at++];
    at += pattern[at] === "\\" ? 2 : 1;
    const [min = "", max] = body.split(",");
    const quantifier = body === "" ? "*" : max === undefined ? `{${min}}` : `{${min || 0},${max}}`;
    out += quantifier + (lazy ? "?" : "");
    return at;
  };

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\") {
      const next = pattern[++i];
      if (next === undefined) out += "\\\\";
      else if (next === "v" || next === "m" || next === "V") mode = next;
      else if (next === "M") mode = "m";
      else if (next === "c") caseFlag = true;
      else if (next === "C") caseFlag = false;
      else if (next === "<" || next === ">") out += "\\b";
      else if (CLASSES[next]) out += CLASSES[next];
      else if (mode === "v") out += literal(next);
      else if ("()|+".includes(next)) out += next;
      else if (next === "?" || next === "=") out += "?";
      else if (next === "{") i = count(i + 1) - 1;
      else if (mode === "V" && ".*[^$".includes(next)) out += next === "[" ? "[" : next;
      else out += literal(next);
    } else if (mode === "V") out += literal(c);
    else if (c === "[") {
      // A class is copied as it is, up to its closing bracket (a `]` first in it is a member).
      let end = i + 1;
      if (pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end += pattern[end] === "\\" ? 2 : 1;
      if (end >= pattern.length) out += "\\[";
      else {
        out += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (".*^$".includes(c)) out += c;
    else if (mode === "v" && "()|+?".includes(c)) out += c;
    else if (mode === "v" && c === "=") out += "?";
    else if (mode === "v" && (c === "<" || c === ">")) out += "\\b";
    else if (mode === "v" && c === "{") i = count(i + 1) - 1;
    else out += literal(c);
  }
  // Smartcase: an uppercase letter that is not part of an escape makes the search match case, as does asking for a
  // case with `\u` / `\l`, which an ignoring regular expression could not keep to.
  const insensitive = caseFlag ?? !(/[A-Z]/.test(pattern.replace(/\\./g, "")) || /\\[uUlL]/.test(pattern));
  return new RegExp(out, flags + (insensitive ? "i" : ""));
}

/**
 * Vim's replacement string for one match: `&` and `\0` the match, `\1`…`\9` its groups, `\r` a line break, `\t` a
 * tab, `\u` `\l` the next character's case, `\U` `\L` the case up to `\E` / `\e`, `\&` a literal ampersand.
 */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  let out = "";
  let one: "u" | "l" | null = null;
  let all: "U" | "L" | null = null;
  const put = (text: string) => {
    for (const ch of text) {
      let c = all === "U" ? ch.toUpperCase() : all === "L" ? ch.toLowerCase() : ch;
      if (one) {
        c = one === "u" ? c.toUpperCase() : c.toLowerCase();
        one = null;
      }
      out += c;
    }
  };
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i] as string;
    if (c === "&") put(match[0]);
    else if (c !== "\\") put(c);
    else {
      const next = replacement[++i] ?? "";
      if (/\d/.test(next)) put(match[Number(next)] ?? "");
      else if (next === "r" || next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "u" || next === "l") one = next;
      else if (next === "U" || next === "L") all = next;
      else if (next === "E" || next === "e") all = null;
      else put(next);
    }
  }
  return out;
}
