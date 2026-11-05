import { type Editor, getMarkRange } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, type Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { bodyStart } from "../body";
import { type VimMode, vimPluginKey } from "./vendor";

/** A span `+` can select: by character, or (`lines`) as whole lines in visual line mode. */
interface Region {
  from: number;
  to: number;
  lines: boolean;
}

const QUOTES = ['"', "'", "`"];
const PAIRS = ["()", "[]", "{}", "“”", "‘’"];
/** A sentence: from a non-blank to `.`, `!` or `?` (and closing quotes or brackets) before a blank, or the end. */
const SENTENCE = /\S[\s\S]*?(?:[.!?]+["')\]”’]*(?=\s|$)|$)/g;
const RESET = { count: null, keyBuffer: "", pendingOperator: null, operatorCount: null, pendingFind: null };

/**
 * `iw` / `aw` (`W` for blanks only) around `at` in its textblock, as offsets into the text: the word under the
 * cursor (or the blanks, when on them); `a` adds the blanks after the word, else the ones before it.
 */
export function wordRange(text: string, at: number, around: boolean, big: boolean): [number, number] | null {
  if (!text) return null;
  const kind = (char: string) => (/\s/.test(char) ? 0 : big || /\w/.test(char) ? 1 : 2);
  const run = (i: number): [number, number] => {
    let start = i;
    let end = i + 1;
    while (start > 0 && kind(text[start - 1]) === kind(text[i])) start--;
    while (end < text.length && kind(text[end]) === kind(text[i])) end++;
    return [start, end];
  };
  const here = Math.min(Math.max(0, at), text.length - 1);
  let [start, end] = run(here);
  if (!around) return [start, end];
  if (kind(text[here]) === 0) {
    if (end < text.length) end = run(end)[1];
  } else if (end < text.length && kind(text[end]) === 0) end = run(end)[1];
  else if (start > 0 && kind(text[start - 1]) === 0) start = run(start - 1)[0];
  return [start, end];
}

/**
 * Vim's text objects around `at` in a textblock's text, as offsets, the order unsorted: `iw`, `iW`, `i"` `i'` `` i` ``
 * (quotes paired from the line's start), `i(` `i[` `i{` for every pair around it, `is` (not in code), the line
 * without its blanks, and the whole text. In code a line ends at a newline, and brackets reach across lines.
 */
export function textRegions(text: string, at: number, code: boolean): [number, number][] {
  const start = code ? text.lastIndexOf("\n", at - 1) + 1 : 0;
  const newline = code ? text.indexOf("\n", at) : -1;
  const line = text.slice(start, newline < 0 ? text.length : newline);
  const here = at - start;
  const found: ([number, number] | null)[] = [wordRange(line, here, false, false), wordRange(line, here, false, true)];
  for (const quote of QUOTES) {
    let open = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== quote) continue;
      if (open < 0) open = i;
      else {
        if (open <= here && here <= i) found.push([open + 1, i]);
        open = -1;
      }
    }
  }
  if (!code)
    for (const match of line.matchAll(SENTENCE))
      if (match.index <= here && here < match.index + match[0].length)
        found.push([match.index, match.index + match[0].length]);
  const blank = line.search(/\S/);
  if (blank >= 0) found.push([blank, line.trimEnd().length]);
  const regions = found
    .filter((range) => range !== null)
    .map(([from, to]): [number, number] => [start + from, start + to]);
  for (const [open, close] of PAIRS) {
    const opened: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === open) opened.push(i);
      else if (text[i] === close && opened.length) {
        const from = opened.pop() ?? 0;
        if (from <= at && at <= i) regions.push([from + 1, i]);
      }
    }
  }
  regions.push([0, text.length]);
  return regions;
}

/** A textblock's text with an inline node (a mention, an emoji) as one character each, so offsets are positions. */
function inlineText(node: Node) {
  let text = "";
  node.forEach((child) => {
    text += child.isText ? (child.text ?? "") : "￼".repeat(child.nodeSize);
  });
  return text;
}

/** From the first textblock between two positions to the end of the last: what a text selection can hold. */
function textSpan(doc: Node, from: number, to: number) {
  const start = TextSelection.findFrom(doc.resolve(from), 1, true);
  const end = TextSelection.findFrom(doc.resolve(to), -1, true);
  return start && end && start.from < end.to ? { from: start.from, to: end.to } : null;
}

/**
 * The regions around `origin`, smallest first and each once: the text objects and inline marks (a link, bold, code)
 * of its textblock by character; the blocks around it (a list item, a list, a quote, a table cell, row, table) and
 * the page's body by line. As in vim-expand-region, a region of one character is no step.
 */
function regions(state: EditorState, origin: number) {
  const { doc } = state;
  const $at = doc.resolve(origin);
  const found: Region[] = [];
  if ($at.parent.isTextblock) {
    const base = $at.start();
    const text = inlineText($at.parent);
    for (const [from, to] of textRegions(text, $at.parentOffset, $at.parent.type.spec.code === true))
      found.push({ from: base + from, to: base + to, lines: false });
    for (const mark of $at.parent.childAfter($at.parentOffset).node?.marks ?? []) {
      const range = getMarkRange($at, mark.type, mark.attrs);
      if (range) found.push({ ...range, lines: false });
    }
  }
  for (let depth = $at.depth - 1; depth > 0; depth--) {
    const span = textSpan(doc, $at.start(depth), $at.end(depth));
    if (span) found.push({ ...span, lines: true });
  }
  // The body, never a page's title.
  const start = bodyStart(doc);
  const body = $at.index(0) >= start && textSpan(doc, start ? doc.child(0).nodeSize : 0, doc.content.size);
  if (body) found.push({ ...body, lines: true });
  return found
    .filter((region) => region.to - region.from > 1 && region.from <= origin && origin <= region.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from) || Number(a.lines) - Number(b.lines))
    .filter((region, i, all) => all.findIndex((r) => r.from === region.from && r.to === region.to) === i);
}

/**
 * vim-expand-region: `+` selects the next larger region around the cursor (in normal or visual mode), `_` the
 * previous one, and past the first, what was there before `+`. Steps go on while the selection is the last one
 * shown; a selection made otherwise starts again from the regions holding it.
 */
export function regionSteps(editor: Editor) {
  let steps: {
    doc: Node;
    regions: Region[];
    trail: number[];
    /** The selection and Vim's state before the first step, which stepping back past it returns to. */
    before: { selection: Selection; mode: VimMode; visualAnchor: number | null; visualHead: number | null };
    from: number;
    to: number;
  } | null = null;

  const going = (state: EditorState) => {
    const vim = vimPluginKey.getState(state);
    const { selection } = state;
    return (
      vim?.mode.startsWith("visual") &&
      state.doc === steps?.doc &&
      selection.from === steps.from &&
      selection.to === steps.to
    );
  };

  const enter = (
    view: EditorView,
    selection: Selection,
    mode: VimMode,
    visualAnchor: number | null,
    visualHead: number | null,
  ) => {
    view.dispatch(
      view.state.tr
        .setSelection(selection)
        .setMeta(vimPluginKey, { ...RESET, mode, visualAnchor, visualHead, desiredColumn: null }),
    );
    // The mode again through the command, which also keeps the editor's `data-vim-mode` and storage.
    editor.commands.setVimMode(mode);
  };

  const show = (view: EditorView, region: Region) => {
    const { doc } = view.state;
    const head = Math.max(doc.resolve(region.to).start(), region.to - 1);
    const selection = TextSelection.create(doc, region.from, region.to);
    enter(view, selection, region.lines ? "visual-line" : "visual", region.from, head);
    if (!steps) return;
    steps.from = view.state.selection.from;
    steps.to = view.state.selection.to;
  };

  return {
    expand(view: EditorView, count: number) {
      const { state } = view;
      const vim = vimPluginKey.getState(state);
      if (!vim) return false;
      if (!steps || !going(state)) {
        const { selection } = state;
        const visual = vim.mode.startsWith("visual");
        const origin = visual ? (vim.visualHead ?? selection.head) : selection.from;
        const [from, to] = visual ? [selection.from, selection.to] : [origin, origin];
        const { mode, visualAnchor, visualHead } = vim;
        steps = {
          doc: state.doc,
          regions: regions(state, origin).filter((region) => region.from <= from && to <= region.to),
          trail: [],
          before: { selection, mode, visualAnchor, visualHead },
          from,
          to,
        };
      }
      const { regions: all, trail } = steps;
      const taken = trail.length;
      for (let n = 0; n < count; n++) {
        const index = trail.at(-1) ?? -1;
        const size = index < 0 ? steps.to - steps.from : all[index].to - all[index].from;
        const next = all.findIndex((region, i) => i > index && region.to - region.from > size);
        if (next < 0) break;
        trail.push(next);
      }
      const last = trail.at(-1);
      if (trail.length > taken && last !== undefined) show(view, all[last]);
      else view.dispatch(state.tr.setMeta(vimPluginKey, RESET));
      return true;
    },

    /** Whether `_` stepped back; else it is Vim's motion. */
    shrink(view: EditorView, count: number) {
      if (!steps || !going(view.state)) return false;
      steps.trail.splice(Math.max(0, steps.trail.length - count));
      const last = steps.trail.at(-1);
      if (last !== undefined) {
        show(view, steps.regions[last]);
        return true;
      }
      const { selection, mode, visualAnchor, visualHead } = steps.before;
      steps = null;
      enter(view, selection, mode, visualAnchor, visualHead);
      return true;
    },
  };
}
