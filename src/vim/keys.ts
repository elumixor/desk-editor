import { type Editor, Extension } from "@tiptap/core";
import type { Node, ResolvedPos } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { bodyStart } from "../body";
import { latinize } from "../latin-key";
import { glideTo, head, linkAt, scroller, scrollTarget, vimCursor } from "./cursor";
import { type LineNumbers, vimLines } from "./lines";
import { regionSteps, wordRange } from "./region";
import { highlight, isShown, jump, lastPattern, lines, searchPlugin } from "./search";
import { moveDown, moveUp, registers, vimPluginKey } from "./vendor";

export type PromptKind = "/" | "?" | ":";
/** Opens the bar for a search or an Ex command; `visual` is the selection's lines when `:` was pressed in it. */
export type VimPrompt = (kind: PromptKind, visual: [number, number] | null) => void;

/**
 * Vim's jumplist, kept by the app: it may run across pages. Told where the cursor is on every move; `armed` says the
 * next move is a jump (`G`, `gg`, `%`, `{`, `}`, `H`, `M`, `L`, a search).
 */
export interface JumpList {
  armed: boolean;
  attach(cursor: { get(): number; set(pos: number): void }): () => void;
  moved(pos: number): void;
  go(step: 1 | -1): unknown;
}

/** What `space <key>` does in normal mode. */
export type Leader = Readonly<Record<string, (editor: Editor) => void>>;

/** The first non-blank character of the next textblock (Enter), or the character before the cursor (Backspace). */
function step(state: EditorState, direction: 1 | -1) {
  const { $head } = state.selection;
  if (direction === -1 && $head.pos > $head.start()) return $head.pos - 1;
  const edge = $head.depth ? (direction === 1 ? $head.after() : $head.before()) : $head.pos;
  const found = TextSelection.findFrom(state.doc.resolve(edge), direction, true);
  if (!found) return null;
  const { $head: $to } = found;
  if (direction === -1) return Math.max($to.start(), $to.pos - 1);
  const blank = $to.parent.textContent.search(/\S/);
  return $to.start() + Math.max(0, blank);
}

/** `o` / `O` in a code block: a new line inside it, after or before the cursor's line; null outside one. */
function codeLineOpen(state: EditorState, below: boolean) {
  const { $head } = state.selection;
  if ($head.parent.type.name !== "codeBlock") return null;
  const text = $head.parent.textContent;
  const at = $head.parentOffset;
  const end = text.indexOf("\n", at);
  const offset = below ? (end === -1 ? text.length : end) : text.lastIndexOf("\n", at - 1) + 1;
  const pos = $head.start() + offset;
  const tr = state.tr.insertText("\n", pos);
  return tr.setSelection(TextSelection.create(tr.doc, below ? pos + 1 : pos));
}

/** `j` / `k` onto, off or past a code block's trailing empty line, which the extension's clamping cannot reach; null elsewhere. */
function codeEdgeStep(view: EditorView, direction: 1 | -1) {
  const { state } = view;
  const { $head } = state.selection;
  if ($head.parent.type.name !== "codeBlock") {
    if (direction === 1 || $head.depth === 0) return null;
    // On the first screen line of the block below: land on the code block's empty last line.
    if (view.coordsAtPos($head.start()).top !== view.coordsAtPos($head.pos).top) return null;
    const prev = TextSelection.findFrom(state.doc.resolve($head.before()), -1, true);
    if (prev?.$head.parent.type.name !== "codeBlock" || !prev.$head.parent.textContent.endsWith("\n")) return null;
    return prev.$head.start() + prev.$head.parent.content.size;
  }
  const text = $head.parent.textContent;
  const at = $head.parentOffset;
  if (direction === 1) {
    if (!text.endsWith("\n")) return null;
    if (at === text.length) {
      const next = TextSelection.findFrom(state.doc.resolve($head.after()), 1, true);
      return next ? next.head : $head.start() + at;
    }
    if (text.indexOf("\n", at) !== text.length - 1) return null;
    return $head.start() + text.length;
  }
  if (at !== text.length || !text.endsWith("\n")) return null;
  return $head.start() + text.lastIndexOf("\n", text.length - 2) + 1;
}

/** `dd` / `yy` / `cc` in a code block act on its lines, not the whole block; null outside one. */
function codeLineOperate(state: EditorState, operator: string, count: number) {
  const { $head } = state.selection;
  if ($head.parent.type.name !== "codeBlock") return null;
  const text = $head.parent.textContent;
  const start = text.lastIndexOf("\n", $head.parentOffset - 1) + 1;
  let end = start;
  for (let i = 0; i < count; i++) {
    const next = text.indexOf("\n", end);
    if (next === -1) {
      end = text.length;
      break;
    }
    end = next + 1;
  }
  const line = text.slice(start, end);
  registers.set({ text: line.endsWith("\n") ? line : `${line}\n`, type: "line" });
  const base = $head.start();
  if (operator === "y") return state.tr.setSelection(TextSelection.create(state.doc, base + start));
  // `cc` keeps one empty line, `dd` removes the lines (and the newline before them when they are the last).
  const keepBreak = operator === "c" || end < text.length || start === 0;
  const from = base + (keepBreak ? start : start - 1);
  const to = base + (operator === "c" && line.endsWith("\n") ? end - 1 : end);
  const tr = state.tr.delete(from, to);
  const cursor = operator === "d" && !keepBreak ? base + text.lastIndexOf("\n", start - 2) + 1 : from;
  return tr.setSelection(TextSelection.create(tr.doc, Math.max(base, cursor)));
}

/** `dd` in a wrapped textblock removes the cursor's screen line(s), not the block; null where the block is one line or not the body's. */
function wrappedLineDelete(view: EditorView, count: number) {
  const { state } = view;
  const { $head } = state.selection;
  if (
    !state.selection.empty ||
    !$head.parent.isTextblock ||
    $head.parent.type.spec.code ||
    $head.index(0) < bodyStart(state.doc)
  )
    return null;
  const [start] = screenLine(view, $head.pos);
  let end = screenLine(view, $head.pos)[1];
  for (let i = 1; i < count && end < $head.end(); i++) end = screenLine(view, end + 1)[1];
  if (start <= $head.start() && end >= $head.end()) return null;
  registers.set({ text: `${state.doc.textBetween(start, end)}\n`, type: "line" });
  const tr = state.tr.delete(start, end);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(start, tr.doc.content.size)), 1));
}

interface TableContext {
  table: Node;
  /** Where the table's rows start. */
  start: number;
  /** The cursor's row, and the first and last row selected (the same, with a cursor). */
  row: number;
  low: number;
  high: number;
  selected: boolean;
}

/** The table the cursor (or a row selection) is in, with the rows it covers; null outside one. */
function tableContext(state: EditorState): TableContext | null {
  const { selection, doc } = state;
  let $cell: ResolvedPos | null = null;
  let $anchor: ResolvedPos | null = null;
  if (selection instanceof CellSelection) {
    $cell = selection.$headCell;
    $anchor = selection.$anchorCell;
  } else {
    const { $head } = selection;
    for (let d = $head.depth; d > 0; d--) {
      const name = $head.node(d).type.name;
      if (name === "tableCell" || name === "tableHeader") {
        $cell = doc.resolve($head.before(d));
        break;
      }
    }
  }
  if (!$cell) return null;
  const depth = $cell.depth - 1;
  const row = $cell.index(depth);
  const other = $anchor ? $anchor.index(depth) : row;
  return {
    table: $cell.node(depth),
    start: $cell.start(depth),
    row,
    low: Math.min(row, other),
    high: Math.max(row, other),
    selected: selection instanceof CellSelection,
  };
}

/** The position before a table's row. */
function rowPos(ctx: TableContext, index: number) {
  let pos = ctx.start;
  for (let i = 0; i < index; i++) pos += ctx.table.child(i).nodeSize;
  return pos;
}

/** The cursor in the first cell of a row. */
function rowStartSelection(state: EditorState, ctx: TableContext, index: number) {
  return TextSelection.findFrom(state.doc.resolve(rowPos(ctx, index) + 2), 1, true);
}

/** A row selection from one row to another, as the table commands take it. */
function rowsSelection(state: EditorState, ctx: TableContext, from: number, to: number, column = 0) {
  const cellAt = (index: number) => {
    const row = ctx.table.child(index);
    let pos = rowPos(ctx, index) + 1;
    for (let i = 0; i < Math.min(column, row.childCount - 1); i++) pos += row.child(i).nodeSize;
    return state.doc.resolve(pos);
  };
  return CellSelection.rowSelection(cellAt(from), cellAt(to));
}

const OPERATOR_RESET = { count: null, keyBuffer: "", operatorCount: null, pendingOperator: null };

/**
 * A table's line is a row. In normal mode: `V` selects the row (`j` / `k` more), `dd` / `D` delete rows, `yy` yanks
 * them as tab-separated text, `cc` clears them, `o` / `O` add a row below / above, `_` `^` `0` go to its first cell.
 * On selected rows `d` `x` `D` `y` `c` act, Escape unselects; any other key unselects and goes on. Whether it took the key.
 */
function tableRowKey(
  editor: Editor,
  view: EditorView,
  vim: NonNullable<ReturnType<typeof vimPluginKey.getState>>,
  key: string,
) {
  const ctx = tableContext(view.state);
  if (!ctx) return false;
  const count = (vim.operatorCount ?? 1) * (vim.count ?? 1);
  const idle = !vim.pendingOperator && !vim.keyBuffer;
  const done = (tr: Transaction) => view.dispatch(tr.setMeta(vimPluginKey, OPERATOR_RESET));
  const last = (rows: number) => Math.min(ctx.table.childCount - 1, ctx.row + rows - 1);
  const yank = (low: number, high: number) => {
    const text: string[] = [];
    for (let i = low; i <= high; i++) {
      const row = ctx.table.child(i);
      text.push(Array.from({ length: row.childCount }, (_, c) => row.child(c).textContent).join("	"));
    }
    registers.set({ text: `${text.join("\n")}\n`, type: "line" });
  };
  const remove = (low: number, high: number) => {
    view.dispatch(view.state.tr.setSelection(rowsSelection(view.state, ctx, low, high)));
    editor.commands.deleteRow();
    done(view.state.tr);
  };
  const clear = (low: number, high: number) => {
    const { paragraph } = view.state.schema.nodes;
    const tr = view.state.tr;
    for (let i = high; i >= low; i--) {
      const row = ctx.table.child(i);
      let pos = rowPos(ctx, i) + 1 + row.content.size;
      for (let c = row.childCount - 1; c >= 0; c--) {
        const cell = row.child(c);
        pos -= cell.nodeSize;
        tr.replaceWith(pos + 1, pos + cell.nodeSize - 1, paragraph.create());
      }
    }
    const found = rowStartSelection(view.state.apply(tr), ctx, low);
    if (found) tr.setSelection(TextSelection.create(tr.doc, found.head));
    done(tr);
    editor.chain().setVimMode("insert").run();
  };
  if (ctx.selected) {
    if (key === "d" || key === "x" || key === "D") remove(ctx.low, ctx.high);
    else if (key === "y") {
      yank(ctx.low, ctx.high);
      const found = rowStartSelection(view.state, ctx, ctx.low);
      done(found ? view.state.tr.setSelection(found) : view.state.tr);
    } else if (key === "c") clear(ctx.low, ctx.high);
    else if (key === "j" || key === "k") {
      const anchor = ctx.row === ctx.low ? ctx.high : ctx.low;
      const head = Math.max(0, Math.min(ctx.table.childCount - 1, ctx.row + (key === "j" ? count : -count)));
      done(view.state.tr.setSelection(rowsSelection(view.state, ctx, anchor, head)));
    } else {
      const found = rowStartSelection(view.state, ctx, ctx.low);
      if (found) view.dispatch(view.state.tr.setSelection(found));
      return key === "Escape";
    }
    return true;
  }
  if (key === "V" && vim.mode === "normal" && idle) {
    done(view.state.tr.setSelection(rowsSelection(view.state, ctx, ctx.row, ctx.row)));
    return true;
  }
  if (key === "D" && idle) remove(ctx.row, ctx.row);
  else if (key === "d" && vim.pendingOperator === "d") remove(ctx.row, last(count));
  else if (key === "y" && vim.pendingOperator === "y") {
    yank(ctx.row, last(count));
    done(view.state.tr);
  } else if (key === "c" && vim.pendingOperator === "c") clear(ctx.row, last(count));
  else if ((key === "o" || key === "O") && idle) {
    if (key === "o") editor.commands.addRowAfter();
    else editor.commands.addRowBefore();
    const found = rowStartSelection(view.state, ctx, key === "o" ? ctx.row + 1 : ctx.row);
    if (found) view.dispatch(view.state.tr.setSelection(found));
    editor.chain().setVimMode("insert").run();
  } else if ((key === "_" || key === "^" || key === "0") && idle) {
    const to = tableRowEdge(view.state, false, false);
    if (to === null) return false;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)));
  } else return false;
  return true;
}

/** The divider `j` / `k` runs into from the cursor's last or first screen line, or leaves from (a selected one); null elsewhere. */
function ruleStep(view: EditorView, direction: 1 | -1) {
  const { state } = view;
  const { selection } = state;
  const isRule = (node: { type: { name: string } } | null | undefined) => node?.type.name === "horizontalRule";
  if (selection instanceof NodeSelection) {
    if (!isRule(selection.node)) return null;
    const edge = direction === 1 ? selection.to : selection.from;
    const found = TextSelection.findFrom(state.doc.resolve(edge), direction, true);
    return found ? found : null;
  }
  const { $head } = selection;
  if (!$head.parent.isTextblock || !$head.depth) return null;
  const [start, end] = screenLine(view, $head.pos);
  if (direction === 1 ? end < $head.end() : start > $head.start()) return null;
  // The last (first) line of a list item or quote is the edge of the whole block: a divider may follow (precede) it.
  let depth = $head.depth;
  while (
    depth > 1 &&
    !/^table/.test($head.node(depth - 1).type.name) &&
    (direction === 1 ? $head.indexAfter(depth - 1) === $head.node(depth - 1).childCount : $head.index(depth - 1) === 0)
  )
    depth--;
  const $edge = state.doc.resolve(direction === 1 ? $head.after(depth) : $head.before(depth));
  const next = direction === 1 ? $edge.nodeAfter : $edge.nodeBefore;
  if (!isRule(next)) return null;
  return NodeSelection.create(state.doc, direction === 1 ? $edge.pos : $edge.pos - (next?.nodeSize ?? 0));
}

/**
 * `dj` / `dk` / `yj` / `yk` (with counts): the cursor's line and the one(s) below or above, whole. A line is a block of
 * the body (a paragraph, a divider...); null where it is not that (a page's title, a table cell, a list), for the
 * extension to handle. A transaction without changes where there is no line to reach.
 */
function linesOperate(state: EditorState, operator: string, direction: 1 | -1, count: number) {
  const { selection, doc } = state;
  const $at = selection instanceof NodeSelection ? selection.$from : selection.$head;
  if ($at.depth > 1 || (selection instanceof NodeSelection ? $at.depth !== 0 : $at.depth !== 1)) return null;
  const index = $at.index(0);
  const body = bodyStart(doc);
  if (index < body) return null;
  const target = Math.max(body, Math.min(doc.childCount - 1, index + direction * count));
  if (target === index) return state.tr;
  const [first, last] = [Math.min(index, target), Math.max(index, target)];
  let from = 0;
  for (let i = 0; i < first; i++) from += doc.child(i).nodeSize;
  let to = from;
  const text: string[] = [];
  for (let i = first; i <= last; i++) {
    text.push(doc.child(i).textBetween(0, doc.child(i).content.size, "\n"));
    to += doc.child(i).nodeSize;
  }
  registers.set({ text: `${text.join("\n")}\n`, type: "line", slice: doc.slice(from, to) });
  const tr = state.tr;
  if (operator === "d") {
    tr.delete(from, to);
    // A body is never empty.
    if (tr.doc.childCount <= body) tr.insert(from, state.schema.nodes.paragraph.create());
  }
  const at = Math.min(from, tr.doc.content.size);
  const first$ = tr.doc.resolve(at);
  return tr.setSelection(
    first$.nodeAfter?.type.name === "horizontalRule" && operator === "y"
      ? NodeSelection.create(tr.doc, at)
      : TextSelection.near(first$, 1),
  );
}

/** `x` / `s` / `dl` / `cl` on a link: all of it, as on a mention, into the register; null off one. */
function linkDelete(state: EditorState) {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const link = linkAt(state, selection.head);
  if (!link) return null;
  registers.set({
    text: state.doc.textBetween(link.from, link.to),
    type: "char",
    slice: state.doc.slice(link.from, link.to),
  });
  const tr = state.tr.delete(link.from, link.to);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(link.from, tr.doc.content.size)), -1));
}

/** `dd` / `x` / Delete on a selected divider or embedded view removes it and lands the cursor on the line that took its place. */
function ruleDelete(state: EditorState) {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || !["horizontalRule", "viewBlock"].includes(selection.node.type.name))
    return null;
  const tr = state.tr.deleteSelection();
  const at = Math.min(selection.from, tr.doc.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(at), -1));
}

/** `j` / `k` in a table: the cell above or below, in the same column, `count` rows away, or the line past its edge; null outside one. */
function tableStep(view: EditorView, direction: 1 | -1, count: number) {
  const { state } = view;
  const { $head } = state.selection;
  for (let d = $head.depth; d > 1; d--) {
    if ($head.node(d).type.name !== "tableCell" && $head.node(d).type.name !== "tableHeader") continue;
    const table = $head.node(d - 2);
    const row = $head.index(d - 2);
    const column = $head.index(d - 1);
    const target = row + direction * count;
    if (target < 0 || target >= table.childCount) {
      // Off the table's edge: the line outside it, a divider selected, where the extension would step to the next cell.
      const edge = state.doc.resolve(direction === 1 ? $head.after(d - 2) : $head.before(d - 2));
      const beside = direction === 1 ? edge.nodeAfter : edge.nodeBefore;
      if (beside?.type.name === "horizontalRule")
        return NodeSelection.create(state.doc, direction === 1 ? edge.pos : edge.pos - beside.nodeSize);
      const found = TextSelection.findFrom(edge, direction, true);
      if (!found) return null;
      // The table is one line: the column is kept, as on any line, where the extension would land at the line's end.
      try {
        const from = view.coordsAtPos($head.pos);
        const to = view.coordsAtPos(found.head, direction === 1 ? 1 : -1);
        const hit = view.posAtCoords({ left: from.left, top: (to.top + to.bottom) / 2 });
        if (hit) {
          const $hit = state.doc.resolve(hit.pos);
          // Normal mode rests on a character, not past the last.
          if ($hit.parent === found.$head.parent)
            return TextSelection.create(state.doc, Math.min(hit.pos, Math.max($hit.start(), $hit.end() - 1)));
        }
      } catch {}
      return found;
    }
    const cells = table.child(target);
    const cell = Math.min(column, cells.childCount - 1);
    let pos = $head.start(d - 2);
    for (let i = 0; i < target; i++) pos += table.child(i).nodeSize;
    pos += 1;
    for (let i = 0; i < cell; i++) pos += cells.child(i).nodeSize;
    // Into the cell's first textblock.
    const found = TextSelection.findFrom(state.doc.resolve(pos + 1), 1, true);
    return found;
  }
  return null;
}

/** `h` / `l` at a table cell's edge: the neighbouring cell, on its first or last character; null elsewhere. */
function tableSide(state: EditorState, direction: 1 | -1) {
  const { $head } = state.selection;
  for (let d = $head.depth; d > 1; d--) {
    if ($head.node(d).type.name !== "tableCell" && $head.node(d).type.name !== "tableHeader") continue;
    const row = $head.node(d - 1);
    const target = $head.index(d - 1) + direction;
    if (target < 0 || target >= row.childCount) return null;
    const atEdge = direction === -1 ? $head.parentOffset === 0 : $head.parentOffset >= $head.parent.content.size - 1;
    if (!atEdge) return null;
    let before = $head.start(d - 1);
    for (let i = 0; i < target; i++) before += row.child(i).nodeSize;
    const cell = row.child(target);
    const at = direction === 1 ? before + 1 : before + cell.nodeSize - 1;
    const found = TextSelection.findFrom(state.doc.resolve(at), direction, true);
    if (!found) return null;
    return direction === -1 && found.$head.parentOffset > 0 ? found.head - 1 : found.head;
  }
  return null;
}

/** `$` / `A` / `I` in a table: the last or first cell of the row; `after` puts the cursor past the last character. Null outside one. */
function tableRowEdge(state: EditorState, end: boolean, after: boolean) {
  const { $head } = state.selection;
  for (let d = $head.depth; d > 1; d--) {
    if ($head.node(d).type.name !== "tableCell" && $head.node(d).type.name !== "tableHeader") continue;
    const row = $head.node(d - 1);
    const target = end ? row.childCount - 1 : 0;
    let before = $head.start(d - 1);
    for (let i = 0; i < target; i++) before += row.child(i).nodeSize;
    const at = end ? before + row.child(target).nodeSize - 1 : before + 1;
    const found = TextSelection.findFrom(state.doc.resolve(at), end ? -1 : 1, true);
    if (!found) return null;
    return end && !after && found.$head.parentOffset > 0 ? found.head - 1 : found.head;
  }
  return null;
}

/**
 * `viw` / `vaw` select the word as Vim does, and `diw` / `ciw` / `yiw` (and `aw`) act on it by selecting it
 * and pressing the operator in visual mode.
 */
function selectWord(view: EditorView, around: boolean, big: boolean, operator: string | null) {
  const { state } = view;
  const vim = vimPluginKey.getState(state);
  const $at = state.doc.resolve(
    vim?.mode === "visual" ? (vim.visualHead ?? state.selection.from) : state.selection.from,
  );
  const text = $at.parent.textBetween(0, $at.parent.content.size, undefined, "\ufffc");
  const range = wordRange(text, $at.parentOffset, around, big);
  const reset = { keyBuffer: "", count: null, pendingOperator: null, operatorCount: null, pendingFind: null };
  if (!range) {
    view.dispatch(state.tr.setMeta(vimPluginKey, reset));
    return;
  }
  const from = $at.start() + range[0];
  const to = $at.start() + range[1];
  view.dispatch(
    state.tr
      .setSelection(TextSelection.create(state.doc, from, to))
      .setMeta(vimPluginKey, { ...reset, mode: "visual", visualAnchor: from, visualHead: to - 1 }),
  );
  if (operator) view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: operator })));
}

/** `zz`: the page glides until the cursor's line is in the middle of the screen. */
function centerCursor(view: EditorView) {
  const area = scroller(view);
  const rect =
    area === document.documentElement ? new DOMRect(0, 0, innerWidth, innerHeight) : area.getBoundingClientRect();
  const target = scrollTarget(area);
  const at = view.coordsAtPos(head(view));
  const shift = target - area.scrollTop;
  glideTo(area, target + ((at.top + at.bottom) / 2 - shift - (rect.top + rect.bottom) / 2));
}

const ARROWS: Record<string, string> = { ArrowLeft: "h", ArrowDown: "j", ArrowUp: "k", ArrowRight: "l" };

/**
 * Ctrl-D / Ctrl-U: the page glides half a screen and the cursor keeps its place on the screen. Where it lands is
 * read with the page jumped there for a moment and back, before anything is painted.
 */
function halfPage(view: EditorView, direction: 1 | -1) {
  const area = scroller(view);
  const now = area.scrollTop;
  const from = scrollTarget(area);
  const at = view.coordsAtPos(view.state.selection.head);
  area.scrollTop = from + (direction * area.clientHeight) / 2;
  const to = area.scrollTop;
  const found = to !== from && view.posAtCoords({ left: at.left, top: (at.top + at.bottom) / 2 - (from - now) });
  area.scrollTop = now;
  glideTo(area, to);
  const doc = view.state.doc;
  const pos = found ? found.pos : direction === 1 ? doc.content.size : 0;
  const selection = TextSelection.near(doc.resolve(Math.min(pos, doc.content.size)), direction === 1 ? -1 : 1);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, selection.head)));
}

/**
 * Whether two characters sit on the same screen line: their boxes overlap vertically. Their tops alone differ where
 * a smaller font (inline code) sits on the same line.
 */
const sameLine = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
  a.top < b.bottom - 1 && b.top < a.bottom - 1;

/** The start and end of the screen line `pos` is on, within its textblock: a wrapped paragraph has several. */
function screenLine(view: EditorView, pos: number): [number, number] {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return [pos, pos];
  const at = view.coordsAtPos(pos, 1);
  let start = pos;
  while (start > $pos.start() && sameLine(view.coordsAtPos(start - 1, 1), at)) start--;
  let end = pos;
  while (end < $pos.end() && sameLine(view.coordsAtPos(end + 1, -1), at)) end++;
  return [start, end];
}

/**
 * Visual line mode (`V`) by screen line, as Zed does with soft wrap: whatever moved Vim's head, the selection is
 * stretched to the whole screen lines from the anchor's to the head's.
 */
function screenLines() {
  let view: EditorView | null = null;
  return new Plugin({
    view(v) {
      view = v;
      return {};
    },
    appendTransaction(transactions, _old, state) {
      const vim = vimPluginKey.getState(state);
      if (!view || vim?.mode !== "visual-line" || vim.visualAnchor === null) return null;
      if (state.selection instanceof CellSelection) return null;
      // Only after Vim moved its head: Escape collapses the selection before it leaves the mode, which must stay.
      if (!transactions.some((tr) => tr.getMeta(vimPluginKey))) return null;
      // Screen positions are read from what is drawn, which is the document before an edit.
      if (transactions.some((tr) => tr.docChanged) || state.doc !== view.state.doc) return null;
      const anchor = vim.visualAnchor;
      const head = vim.visualHead ?? anchor;
      const [from, to] =
        head >= anchor
          ? [screenLine(view, anchor)[0], screenLine(view, head)[1]]
          : [screenLine(view, anchor)[1], screenLine(view, head)[0]];
      const { selection } = state;
      if (selection.anchor === from && selection.head === to) return null;
      return state.tr.setSelection(TextSelection.create(state.doc, from, to));
    },
  });
}

/**
 * A visual selection that covers all the content of whole table rows is those rows selected, as `V` does: the rows
 * are selected as cells and Vim returns to normal mode, where the row operators act on them.
 */
function rowSelections(editor: Editor) {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      const vim = vimPluginKey.getState(state);
      const { selection, doc } = state;
      if (!vim?.mode.startsWith("visual") || !(selection instanceof TextSelection) || selection.empty) return null;
      if (!transactions.some((tr) => tr.selectionSet || tr.getMeta(vimPluginKey))) return null;
      const { $from, $to } = selection;
      for (let d = Math.min($from.depth, $to.depth); d > 0; d--) {
        if ($from.node(d).type.name !== "table" || $from.node(d) !== $to.node(d) || $from.start(d) !== $to.start(d))
          continue;
        const table = $from.node(d);
        const [first, last] = [$from.index(d), $to.index(d)];
        const rowAt = (index: number) => {
          let pos = $from.start(d);
          for (let i = 0; i < index; i++) pos += table.child(i).nodeSize;
          return pos;
        };
        // From the first cell's text to the last cell's text.
        if (selection.from > rowAt(first) + 3 || selection.to < rowAt(last) + table.child(last).nodeSize - 3)
          return null;
        return state.tr
          .setSelection(CellSelection.rowSelection(doc.resolve(rowAt(first) + 1), doc.resolve(rowAt(last) + 1)))
          .setMeta(vimPluginKey, {
            ...OPERATOR_RESET,
            mode: "normal",
            visualAnchor: null,
            visualHead: null,
            desiredColumn: null,
          });
      }
      return null;
    },
    view: () => ({
      update(view) {
        if (!(view.state.selection instanceof CellSelection) || vimPluginKey.getState(view.state)?.mode !== "normal")
          return;
        // The mode again where the editor keeps it, without the command, which would unselect.
        view.dom.setAttribute("data-vim-mode", "normal");
        const storage = editor.storage as unknown as { vim: { mode: string } };
        storage.vim.mode = "normal";
      },
    }),
  });
}

/** A selection made with the mouse in normal mode puts Vim in visual mode, with the selection as it is drawn. */
function mouseVisual() {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mouseup(view) {
          const { state } = view;
          const { selection } = state;
          if (vimPluginKey.getState(state)?.mode !== "normal") return false;
          if (!(selection instanceof TextSelection) || selection.empty) return false;
          const forward = selection.head > selection.anchor;
          view.dispatch(
            state.tr.setMeta(vimPluginKey, {
              ...OPERATOR_RESET,
              pendingFind: null,
              mode: "visual",
              visualAnchor: forward ? selection.anchor : selection.anchor - 1,
              visualHead: forward ? selection.head - 1 : selection.head,
            }),
          );
          return false;
        },
      },
    },
  });
}

/** Visual mode's selection from its anchor to a head, both ends included, as the Vim extension makes it. */
function visualTo(state: EditorState, anchor: number | null, head: number) {
  const from = anchor ?? state.selection.anchor;
  const end = (pos: number) => Math.min(state.doc.resolve(pos).end(), pos + 1);
  return state.tr.setSelection(
    head >= from ? TextSelection.create(state.doc, from, end(head)) : TextSelection.create(state.doc, end(from), head),
  );
}

/** `*` / `#`: the whole word under the cursor, as a pattern. */
function wordAt(state: EditorState) {
  const { $head } = state.selection;
  const text = $head.parent.textContent;
  const at = $head.parentOffset;
  const before = /\w*$/.exec(text.slice(0, at + 1))?.[0] ?? "";
  const after = /^\w*/.exec(text.slice(at + 1))?.[0] ?? "";
  const word = before + after;
  return /^\w+$/.test(word) ? `\\<${word}\\>` : null;
}

/** The lines a visual selection covers, by index, for `'<,'>`. */
function selectedLines(state: EditorState): [number, number] {
  const all = lines(state.doc);
  const index = (pos: number) =>
    Math.max(
      0,
      all.findLastIndex((l) => l.start <= pos),
    );
  const { from, to } = state.selection;
  return [index(from), index(Math.max(from, to - 1))];
}

/** Reports the cursor to the jumplist, and which of its moves are jumps (`G`, `gg`, `%`, `{`, `}`, `H`, `M`, `L`; search arms it itself). */
function jumpList(jumps: JumpList) {
  return new Plugin({
    props: {
      handleKeyDown(_view, event) {
        jumps.armed = false;
        const vim = vimPluginKey.getState(_view.state);
        if (vim?.mode !== "normal" || event.ctrlKey || event.metaKey || event.altKey) return false;
        if ("G%{}HML".includes(event.key) || (event.key === "g" && vim.keyBuffer === "g")) jumps.armed = true;
        return false;
      },
    },
    view(view) {
      const detach = jumps.attach({
        get: () => view.state.selection.head,
        set: (pos) => {
          const doc = view.state.doc;
          const at = Math.max(0, Math.min(pos, doc.content.size));
          view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(at))).scrollIntoView());
        },
      });
      return {
        update(view, prev) {
          if (view.state.selection.head !== prev.selection.head) jumps.moved(view.state.selection.head);
        },
        destroy: detach,
      };
    },
  });
}

/**
 * What the editor adds to Vim's normal mode, as in Zed: `space <key>` does what `leader` says; `zz` centres the cursor; `/` and `?` search the page
 * with Vim's patterns, `*` and `#` the word under the cursor (`n`, `N` step through the matches, Escape clears
 * them); `:` takes an Ex command (`:s`, also from visual mode); Ctrl-D / Ctrl-U scroll half a page; Enter and
 * Backspace move instead of editing; `+` / `_` select a larger / smaller region (`vim-region.ts`). Runs before the
 * Vim extension, which swallows every other key; draws Vim's cursor.
 */
export const VimKeys = Extension.create<{
  onPrompt: VimPrompt;
  scrolloff: () => number;
  lineNumbers: () => LineNumbers;
  numbersSide: () => "left" | "right";
  leader?: Leader;
  jumps?: JumpList;
}>({
  name: "vimKeys",
  priority: 110,
  addOptions() {
    return { onPrompt: () => {}, scrolloff: () => 0, lineNumbers: () => "off", numbersSide: () => "right" };
  },
  addProseMirrorPlugins() {
    const { onPrompt, scrolloff, lineNumbers, numbersSide, leader, jumps } = this.options;
    const editor = this.editor;
    let leading = false;
    let zed = false;
    // `i` / `a` after `v` or an operator: waits for the object (`w`, `W`) it picks.
    let object: "i" | "a" | null = null;
    const region = regionSteps(editor);
    return [
      vimCursor(scrolloff),
      vimLines(lineNumbers, numbersSide),
      screenLines(),
      rowSelections(editor),
      mouseVisual(),
      searchPlugin(() => {
        if (jumps) jumps.armed = true;
      }),
      ...(jumps ? [jumpList(jumps)] : []),
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const vim = vimPluginKey.getState(view.state);
            if (vim && vim.mode !== "insert" && !vim.pendingFind) latinize(event);
            const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
            const arrow = plain && vim && event.key in ARROWS;
            // Arrows move like h j k l in every mode; Insert mode keeps its native ones.
            if (arrow && vim.mode !== "insert") Object.defineProperty(event, "key", { value: ARROWS[event.key] });
            if (vim && vim.mode !== "insert" && !vim.pendingFind && !event.metaKey && !event.ctrlKey && !event.altKey) {
              const around = object === "a";
              const waiting = object !== null;
              object = null;
              if (waiting && (event.key === "w" || event.key === "W")) {
                event.preventDefault();
                selectWord(view, around, event.key === "W", vim.pendingOperator);
                return true;
              }
              if (
                !waiting &&
                (event.key === "i" || event.key === "a") &&
                (vim.mode === "visual" || vim.pendingOperator)
              ) {
                event.preventDefault();
                object = event.key;
                return true;
              }
              if ((event.key === "+" || event.key === "_") && !vim.pendingOperator && /^\d*$/.test(vim.keyBuffer)) {
                const count = vim.count ?? 1;
                // `_` with no step to take back is Vim's motion.
                if (event.key === "+" ? region.expand(view, count) : region.shrink(view, count)) {
                  event.preventDefault();
                  return true;
                }
              }
            }
            if (vim?.mode === "visual-line" && (event.key === "j" || event.key === "k") && !vim.pendingFind) {
              // By screen line, where the Vim extension would jump a whole block.
              event.preventDefault();
              const move = event.key === "j" ? moveDown : moveUp;
              const at = vim.visualHead ?? view.state.selection.head;
              const { pos, column } = move(view, view.state, at, vim.count ?? 1, vim.desiredColumn || null);
              view.dispatch(
                view.state.tr.setMeta(vimPluginKey, {
                  visualHead: pos,
                  desiredColumn: column || null,
                  count: null,
                  keyBuffer: "",
                }),
              );
              return true;
            }
            if (
              vim?.mode === "normal" &&
              (event.key === "j" || event.key === "k") &&
              !vim.pendingFind &&
              !vim.pendingOperator &&
              !vim.keyBuffer
            ) {
              // A divider is a line of its own: `j` / `k` select it, then move on.
              const rule = ruleStep(view, event.key === "j" ? 1 : -1);
              if (rule) {
                event.preventDefault();
                view.dispatch(
                  view.state.tr
                    .setSelection(rule)
                    .setMeta(vimPluginKey, { count: null, keyBuffer: "", desiredColumn: null }),
                );
                return true;
              }
              // A table is walked by rows, where Vim would go cell by cell.
              const to = tableStep(view, event.key === "j" ? 1 : -1, vim.count ?? 1);
              if (to !== null) {
                event.preventDefault();
                view.dispatch(
                  view.state.tr
                    .setSelection(to)
                    .setMeta(vimPluginKey, { count: null, keyBuffer: "", desiredColumn: null }),
                );
                return true;
              }
              const edge = codeEdgeStep(view, event.key === "j" ? 1 : -1);
              if (edge !== null) {
                event.preventDefault();
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, edge))
                    .setMeta(vimPluginKey, { count: null, keyBuffer: "", desiredColumn: null }),
                );
                return true;
              }
              // By screen line: the extension keeps a failed measure (column 0) as the goal column, then jumps whole blocks.
              event.preventDefault();
              const move = event.key === "j" ? moveDown : moveUp;
              const { pos, column } = move(
                view,
                view.state,
                view.state.selection.head,
                vim.count ?? 1,
                vim.desiredColumn || null,
              );
              view.dispatch(
                view.state.tr
                  .setSelection(TextSelection.create(view.state.doc, pos))
                  .setMeta(vimPluginKey, { count: null, keyBuffer: "", desiredColumn: column || null }),
              );
              return true;
            }
            if (
              vim?.mode === "normal" &&
              (event.key === "h" || event.key === "l") &&
              !vim.pendingFind &&
              !vim.pendingOperator &&
              !vim.keyBuffer
            ) {
              // A table cell's edge crosses into the next column.
              const to = tableSide(view.state, event.key === "l" ? 1 : -1);
              if (to !== null) {
                event.preventDefault();
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, to))
                    .setMeta(vimPluginKey, { count: null, keyBuffer: "", desiredColumn: null }),
                );
                return true;
              }
            }
            if (
              (vim?.mode === "normal" || vim?.mode === "visual") &&
              event.key === "$" &&
              !vim.pendingFind &&
              !vim.pendingOperator &&
              !vim.keyBuffer
            ) {
              // The end of the screen line, where the Vim extension goes to the end of the whole block.
              event.preventDefault();
              const at =
                vim.mode === "visual" ? (vim.visualHead ?? view.state.selection.head) : view.state.selection.head;
              const [start, end] = screenLine(view, at);
              const to = tableRowEdge(view.state, true, false) ?? Math.max(start, end - 1);
              view.dispatch(
                vim.mode === "visual"
                  ? visualTo(view.state, vim.visualAnchor, to).setMeta(vimPluginKey, {
                      visualHead: to,
                      count: null,
                      keyBuffer: "",
                      desiredColumn: null,
                    })
                  : view.state.tr
                      .setSelection(TextSelection.create(view.state.doc, to))
                      .setMeta(vimPluginKey, { count: null, keyBuffer: "", desiredColumn: null }),
              );
              return true;
            }
            if (
              vim?.mode === "normal" &&
              (event.key === "A" || event.key === "I") &&
              !vim.pendingFind &&
              !vim.pendingOperator &&
              !vim.keyBuffer
            ) {
              // In a table: insert at the end of the row's last cell, or the start of its first.
              const to = tableRowEdge(view.state, event.key === "A", true);
              if (to !== null) {
                event.preventDefault();
                editor.chain().setTextSelection(to).setVimMode("insert").run();
                return true;
              }
            }
            if (
              vim?.mode === "normal" &&
              event.key === "a" &&
              !vim.pendingFind &&
              !vim.pendingOperator &&
              !vim.keyBuffer
            ) {
              // On a link, which is one block outside insert mode: insert after the whole link.
              const link = linkAt(view.state, view.state.selection.head);
              if (link) {
                event.preventDefault();
                editor.chain().setTextSelection(link.to).setVimMode("insert").run();
                return true;
              }
            }
            if (vim?.mode === "normal" && !vim.pendingOperator && !vim.pendingFind && !vim.keyBuffer) {
              const rule = view.state.selection;
              if (
                rule instanceof NodeSelection &&
                rule.node.type.name === "horizontalRule" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey
              ) {
                const key = event.key;
                if ("oOiaIA".includes(key) && key.length === 1) {
                  // An empty line is opened next to the divider: below it, or above for `O`.
                  event.preventDefault();
                  const at = key === "O" ? rule.from : rule.to;
                  const tr = view.state.tr.insert(at, view.state.schema.nodes.paragraph.create());
                  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)));
                  editor.chain().setVimMode("insert").run();
                  return true;
                }
                const entry = registers.get();
                if ((key === "p" || key === "P") && entry) {
                  // Pasted as lines next to the divider: below it, or above for `P`.
                  event.preventDefault();
                  const at = key === "P" ? rule.from : rule.to;
                  const pieces =
                    entry.type === "line"
                      ? entry.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
                      : [entry.text];
                  const { paragraph } = view.state.schema.nodes;
                  const tr = view.state.tr.insert(
                    at,
                    pieces.map((line) => paragraph.create(null, line ? view.state.schema.text(line) : undefined)),
                  );
                  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)));
                  return true;
                }
                if ("hlwbeWBE0^$".includes(key) && key.length === 1) {
                  // Motions along a line have nowhere to go on a divider: they step off it.
                  event.preventDefault();
                  const forward = "lweWE$".includes(key);
                  const found = TextSelection.findFrom(
                    view.state.doc.resolve(forward ? rule.to : rule.from),
                    forward ? 1 : -1,
                    true,
                  );
                  if (found) view.dispatch(view.state.tr.setSelection(found));
                  return true;
                }
              }
            }
            if (
              vim?.mode === "normal" &&
              (event.key === "j" || event.key === "k") &&
              (vim.pendingOperator === "d" || vim.pendingOperator === "y") &&
              !vim.pendingFind &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey
            ) {
              const count = (vim.operatorCount ?? 1) * (vim.count ?? 1);
              const tr = linesOperate(view.state, vim.pendingOperator, event.key === "j" ? 1 : -1, count);
              if (tr) {
                event.preventDefault();
                view.dispatch(
                  tr.setMeta(vimPluginKey, { count: null, keyBuffer: "", operatorCount: null, pendingOperator: null }),
                );
                return true;
              }
            }
            if (
              (vim?.mode === "normal" &&
                ((vim.pendingOperator === "d" && event.key === "d") || (!vim.pendingOperator && event.key === "x")) &&
                !vim.pendingFind) ||
              event.key === "Backspace" ||
              event.key === "Delete"
            ) {
              const tr = ruleDelete(view.state);
              if (tr) {
                event.preventDefault();
                view.dispatch(
                  tr.setMeta(vimPluginKey, { count: null, keyBuffer: "", operatorCount: null, pendingOperator: null }),
                );
                return true;
              }
            }
            const linkKey =
              (!vim?.pendingOperator && (event.key === "x" || event.key === "s")) ||
              ((vim?.pendingOperator === "d" || vim?.pendingOperator === "c") && event.key === "l");
            if (
              vim?.mode === "normal" &&
              linkKey &&
              !vim.pendingFind &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey
            ) {
              const change = event.key === "s" || vim.pendingOperator === "c";
              const tr = linkDelete(view.state);
              if (tr) {
                event.preventDefault();
                view.dispatch(
                  tr.setMeta(vimPluginKey, { count: null, keyBuffer: "", operatorCount: null, pendingOperator: null }),
                );
                if (change) editor.chain().setVimMode("insert").run();
                return true;
              }
            }
            if (vim?.mode === "normal" && !vim.pendingFind && !event.metaKey && !event.ctrlKey && !event.altKey) {
              if (tableRowKey(editor, view, vim, event.key)) {
                event.preventDefault();
                return true;
              }
            }
            if (vim?.mode === "normal" && vim.pendingOperator === "d" && event.key === "d" && !vim.pendingFind) {
              const tr = wrappedLineDelete(view, (vim.operatorCount ?? 1) * (vim.count ?? 1));
              if (tr) {
                event.preventDefault();
                view.dispatch(
                  tr.setMeta(vimPluginKey, { count: null, keyBuffer: "", operatorCount: null, pendingOperator: null }),
                );
                return true;
              }
            }
            if (
              vim?.mode === "normal" &&
              vim.pendingOperator === event.key &&
              "dyc".includes(event.key) &&
              !vim.pendingFind
            ) {
              const tr = codeLineOperate(view.state, event.key, (vim.operatorCount ?? 1) * (vim.count ?? 1));
              if (tr) {
                event.preventDefault();
                view.dispatch(
                  tr.setMeta(vimPluginKey, { count: null, keyBuffer: "", operatorCount: null, pendingOperator: null }),
                );
                if (event.key === "c") editor.chain().setVimMode("insert").run();
                return true;
              }
            }
            if (
              vim?.mode === "normal" &&
              (event.key === "o" || event.key === "O") &&
              !vim.pendingFind &&
              !vim.pendingOperator &&
              !vim.keyBuffer
            ) {
              const tr = codeLineOpen(view.state, event.key === "o");
              if (tr) {
                event.preventDefault();
                view.dispatch(tr);
                editor.chain().setVimMode("insert").run();
                return true;
              }
            }
            if (vim?.mode.startsWith("visual") && event.key === ":" && !vim.keyBuffer) {
              event.preventDefault();
              const visual = selectedLines(view.state);
              editor.chain().setTextSelection(view.state.selection.from).setVimMode("normal").run();
              onPrompt(":", visual);
              return true;
            }
            const idle = vim?.mode === "normal" && !vim.keyBuffer && !vim.pendingOperator && !vim.pendingFind;
            if (idle && event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "d" || event.key === "u")) {
              event.preventDefault();
              halfPage(view, event.key === "d" ? 1 : -1);
              return true;
            }
            if (
              jumps &&
              idle &&
              event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              (event.key === "o" || event.key === "i")
            ) {
              event.preventDefault();
              void jumps.go(event.key === "o" ? -1 : 1);
              return true;
            }
            if (!idle || event.metaKey || event.ctrlKey || event.altKey) {
              leading = false;
              zed = false;
              return false;
            }
            if (zed) {
              zed = false;
              if (event.key !== "z") return false;
              centerCursor(view);
            } else if (event.key === "z") zed = true;
            else if (leading) {
              leading = false;
              leader?.[event.key]?.(editor);
            } else if (event.key === " " && leader) leading = true;
            else if (event.key === "/" || event.key === "?" || event.key === ":") onPrompt(event.key, null);
            else if (event.key === "*" || event.key === "#") {
              const pattern = wordAt(view.state);
              if (pattern) {
                highlight(view, { pattern, reverse: event.key === "#" });
                jump(view, 1);
              }
            } else if (event.key === "Enter" || event.key === "Backspace") {
              const to = step(view.state, event.key === "Enter" ? 1 : -1);
              if (to !== null) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)));
            } else if ((event.key === "n" || event.key === "N") && lastPattern(view))
              jump(view, event.key === "n" ? 1 : -1);
            else {
              if (event.key === "Escape" && isShown(view)) highlight(view, { shown: false });
              return false;
            }
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
