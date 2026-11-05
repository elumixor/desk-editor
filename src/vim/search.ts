import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { vimRegex } from "./regex";

interface Match {
  readonly from: number;
  readonly to: number;
}

interface SearchState {
  /** The last pattern searched for: `n` and `N` keep finding it after its highlights are cleared. */
  readonly pattern: string;
  /** Searched with `?` or `#`: `n` goes up the page. */
  readonly reverse: boolean;
  readonly shown: boolean;
  readonly matches: readonly Match[];
}

type SearchMeta = Partial<Pick<SearchState, "pattern" | "reverse" | "shown">>;

const searchKey = new PluginKey<SearchState>("vimSearch");

/** A textblock's text, one character per inline leaf, so an offset in the text is an offset in the block. */
export interface Line {
  readonly start: number;
  readonly text: string;
  /** A divider: a line with no text, which the cursor selects rather than sits in. */
  readonly rule?: boolean;
}

/** The document's lines, as Vim counts them: its textblocks and dividers, in order. */
export function lines(doc: PmNode): Line[] {
  const found: Line[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "horizontalRule") {
      found.push({ start: pos, text: "", rule: true });
      return false;
    }
    if (!node.isTextblock) return true;
    found.push({ start: pos + 1, text: doc.textBetween(pos + 1, pos + node.nodeSize - 1, undefined, "￼") });
    return false;
  });
  return found;
}

/** Every match of a Vim pattern; none while it is not a valid one (half typed, say). */
function search(doc: PmNode, pattern: string): Match[] {
  if (!pattern) return [];
  let regex: RegExp;
  try {
    regex = vimRegex(pattern);
  } catch {
    return [];
  }
  const found: Match[] = [];
  for (const line of lines(doc))
    for (const match of line.text.matchAll(regex))
      if (match[0]) found.push({ from: line.start + match.index, to: line.start + match.index + match[0].length });
  return found;
}

export function lastPattern(view: EditorView) {
  return searchKey.getState(view.state)?.pattern ?? "";
}

/** Highlights every match of `pattern` (Vim's hlsearch) and remembers it for `n`; `shown: false` clears them. */
export function highlight(view: EditorView, meta: SearchMeta) {
  view.dispatch(view.state.tr.setMeta(searchKey, meta));
}

/**
 * Moves the cursor to the next match after `from` (`direction` -1: the previous before it), wrapping around the
 * document; false when there is none.
 */
export function jump(view: EditorView, direction: 1 | -1, from = view.state.selection.from) {
  const state = searchKey.getState(view.state);
  if (!state?.pattern) return false;
  if (!state.shown) highlight(view, { shown: true });
  const matches = searchKey.getState(view.state)?.matches ?? [];
  const forward = (direction === 1) !== state.reverse;
  const next = forward
    ? (matches.find((m) => m.from > from) ?? matches[0])
    : (matches.findLast((m) => m.from < from) ?? matches[matches.length - 1]);
  if (!next) return false;
  (searchKey.get(view.state)?.spec as { onJump?: () => void } | undefined)?.onJump?.();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, next.from)));
  return true;
}

/** The matches of the last search, highlighted in the page while they are shown; `onJump` hears each jump to one. */
export function searchPlugin(onJump?: () => void) {
  return new Plugin<SearchState>({
    key: searchKey,
    onJump,
    state: {
      init: () => ({ pattern: "", reverse: false, shown: false, matches: [] }),
      apply(tr, value) {
        const meta = tr.getMeta(searchKey) as SearchMeta | undefined;
        if (!meta && !tr.docChanged) return value;
        const next = { ...value, ...(meta?.pattern !== undefined && { shown: true }), ...meta };
        return { ...next, matches: next.shown ? search(tr.doc, next.pattern) : [] };
      },
    },
    props: {
      decorations(state) {
        const matches = searchKey.getState(state)?.matches ?? [];
        return DecorationSet.create(
          state.doc,
          matches.map((m) => Decoration.inline(m.from, m.to, { class: "vim-match" })),
        );
      },
    },
  });
}

export const isShown = (view: EditorView) => Boolean(searchKey.getState(view.state)?.shown);
