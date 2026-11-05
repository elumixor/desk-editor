import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { expandReplacement, vimRegex } from "./regex";
import { highlight, type Line, lastPattern, lines } from "./search";

/** What a command has to say: a count of what it did, or why it could not. */
export type Outcome = { message?: string; error?: string };

interface Substitute {
  readonly pattern: string;
  readonly replacement: string;
  readonly flags: string;
}

/** The last `:s`, which `:s` and `:&` alone repeat. */
let previous: Substitute | null = null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The line a position is on, by index into `all`. */
function lineOf(all: readonly Line[], pos: number) {
  const index = all.findLastIndex((l) => l.start <= pos);
  return Math.max(0, index);
}

/**
 * Reads the range at the start of a command: `%`, or one or two addresses (`.`, `$`, a line number, `'<` / `'>` for a
 * visual selection, each with an optional `+n` / `-n`). Lines are 0-based here; what is left of the input comes back.
 */
function parseRange(input: string, current: number, last: number, visual: readonly [number, number] | null) {
  if (input.startsWith("%")) return { range: [0, last] as [number, number], rest: input.slice(1), given: true };
  const address = /^\s*(\.|\$|\d+|'<|'>)?((?:\s*[+-]\s*\d*)*)/;
  const read = (text: string): [number | null, string] => {
    const match = address.exec(text);
    if (!match || (!match[1] && !match[2])) return [null, text];
    const [, base = ".", offsets = ""] = match;
    let line =
      base === "."
        ? current
        : base === "$"
          ? last
          : base === "'<"
            ? (visual?.[0] ?? current)
            : base === "'>"
              ? (visual?.[1] ?? current)
              : Number(base) - 1;
    for (const [, sign, n] of offsets.matchAll(/([+-])\s*(\d*)/g)) line += (sign === "+" ? 1 : -1) * Number(n || 1);
    return [Math.max(0, Math.min(last, line)), text.slice(match[0].length)];
  };
  const [first, afterFirst] = read(input);
  if (first === null) return { range: [current, current] as [number, number], rest: input, given: false };
  if (!afterFirst.startsWith(",")) return { range: [first, first] as [number, number], rest: afterFirst, given: true };
  const [second, afterSecond] = read(afterFirst.slice(1));
  const end = second ?? first;
  return { range: [Math.min(first, end), Math.max(first, end)] as [number, number], rest: afterSecond, given: true };
}

/** `/pattern/replacement/flags` with any delimiter that is not a letter, digit, space, `"` or `|`; null if malformed. */
export function parseSubstitute(text: string): Substitute | null {
  const delimiter = text[0];
  if (!delimiter || /[\w\s"|\\]/.test(delimiter)) return null;
  const parts: string[] = [""];
  for (let i = 1; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\\" && text[i + 1] === delimiter && parts.length < 3) {
      // An escaped delimiter is the character itself; a slash keeps its escape, which the pattern reads as a slash.
      parts[parts.length - 1] += delimiter === "/" ? "\\/" : delimiter;
      i++;
    } else if (c === "\\" && i + 1 < text.length) {
      parts[parts.length - 1] += c + text[++i];
    } else if (c === delimiter && parts.length < 3) parts.push("");
    else parts[parts.length - 1] += c;
  }
  const [pattern = "", replacement = "", flags = ""] = parts;
  return { pattern, replacement, flags: flags.trim() };
}

/** Splits an Ex command line into its range and what follows, for the bar to highlight a `:s` pattern while typed. */
export function substitutePattern(view: EditorView, input: string): string | null {
  const all = lines(view.state.doc);
  const { rest } = parseRange(input.replace(/^:/, ""), 0, all.length - 1, null);
  const match = /^\s*s(?:ubstitute)?(.*)$/.exec(rest);
  return match ? (parseSubstitute(match[1] ?? "")?.pattern ?? null) : null;
}

function substitute(view: EditorView, range: [number, number], command: Substitute): Outcome {
  const flags = command.flags.replace("&", previous?.flags ?? "");
  const pattern = command.pattern || lastPattern(view);
  if (!pattern) return { error: "No previous regular expression" };
  const ignoreCase = flags.includes("I") ? false : flags.includes("i") ? true : undefined;
  let regex: RegExp;
  try {
    regex = vimRegex(pattern, "g", ignoreCase);
  } catch {
    return { error: `Invalid pattern: ${pattern}` };
  }
  previous = { pattern, replacement: command.replacement, flags: command.flags };
  const global = flags.includes("g");
  const countOnly = flags.includes("n");
  const all = lines(view.state.doc);
  const tr = view.state.tr;
  let count = 0;
  let changed = 0;
  let lastLine: Line | null = null;
  // Bottom up, and right to left in a line: what is replaced never moves what is still to be.
  for (let index = range[1]; index >= range[0]; index--) {
    const line = all[index];
    if (!line || line.rule) continue;
    const found = [...line.text.matchAll(regex)];
    const matches = global ? found : found.slice(0, 1);
    if (!matches.length) continue;
    count += matches.length;
    changed++;
    lastLine ??= line;
    if (countOnly) continue;
    for (const match of matches.reverse()) {
      const from = line.start + match.index;
      const to = from + match[0].length;
      const pieces = expandReplacement(command.replacement, match).split("\n");
      if (to > from) tr.delete(from, to);
      let at = from;
      pieces.forEach((piece, i) => {
        if (piece) tr.insertText(piece, at);
        at += piece.length;
        if (i < pieces.length - 1) {
          tr.split(at);
          at += 2;
        }
      });
    }
  }
  if (!count) return flags.includes("e") ? {} : { error: `Pattern not found: ${pattern}` };
  if (countOnly) return { message: `${plural(count, "match")} on ${plural(changed, "line")}` };
  if (lastLine) {
    // The cursor goes to the first non-blank character of the last line changed, as in Vim.
    const start = tr.mapping.map(lastLine.start);
    const text = tr.doc.resolve(start).parent.textContent;
    tr.setSelection(TextSelection.create(tr.doc, start + Math.max(0, text.search(/\S/))));
  }
  view.dispatch(tr);
  highlight(view, { pattern, reverse: false });
  return count > 1 ? { message: `${plural(count, "substitution")} on ${plural(changed, "line")}` } : {};
}

/**
 * Runs an Ex command typed after `:` — `:[range]s/pattern/replacement/[flags]` (flags `g` `i` `I` `n` `e` `&`),
 * `:s` / `:&` to repeat the last one, `:noh` to clear the highlights, `:<line>` to go to a line. `visual` is the
 * selection's lines when `:` was pressed in visual mode, which `'<,'>` names.
 */
export function runCommand(view: EditorView, input: string, visual: readonly [number, number] | null): Outcome {
  const all = lines(view.state.doc);
  const current = lineOf(all, view.state.selection.head);
  const { range, rest, given } = parseRange(input.replace(/^:/, ""), current, all.length - 1, visual);
  const command = rest.trim();
  if (!command) {
    if (!given) return {};
    const line = all[range[1]];
    if (line)
      view.dispatch(
        view.state.tr.setSelection(
          line.rule
            ? NodeSelection.create(view.state.doc, line.start)
            : TextSelection.create(view.state.doc, line.start),
        ),
      );
    return {};
  }
  if (/^noh(l(s(e(a(r(ch?)?)?)?)?)?)?$/.test(command)) {
    highlight(view, { shown: false });
    return {};
  }
  const repeat = /^(?:s(?:ubstitute)?|&&?)\s*([&cegiInp]*)$/.exec(command);
  if (repeat) {
    if (!previous) return { error: "No previous substitute regular expression" };
    const keep = command.startsWith("&&");
    return substitute(view, range, { ...previous, flags: keep ? previous.flags : (repeat[1] ?? "") });
  }
  const match = /^s(?:ubstitute)?(.*)$/.exec(command);
  const parsed = match && parseSubstitute(match[1] ?? "");
  if (parsed) return substitute(view, range, parsed);
  return { error: `Not an editor command: ${command}` };
}
