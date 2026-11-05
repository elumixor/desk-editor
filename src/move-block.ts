import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { bodyStart } from "./body";

const MOVABLE = new Set(["tableRow", "listItem", "taskItem"]);

/** Swaps the block around the cursor (its table row or list item, else its top-level block) with its neighbour. */
function move(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view;
  const { $from, anchor, head } = state.selection;

  let depth = $from.depth;
  while (depth > 1 && !MOVABLE.has($from.node(depth).type.name)) depth--;
  if (depth < 1) return false;

  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const other = index + direction;
  // A page's title stays put and nothing moves above it.
  const first = depth === 1 ? bodyStart(state.doc) : 0;
  if (other < first || other >= parent.childCount) return true;

  const node = parent.child(index);
  const neighbour = parent.child(other);
  const start = $from.before(depth);
  const end = start + node.nodeSize;
  const swapped = direction === 1 ? [neighbour, node] : [node, neighbour];
  const from = direction === 1 ? start : start - neighbour.nodeSize;
  const to = direction === 1 ? end + neighbour.nodeSize : end;
  const shift = direction * neighbour.nodeSize;

  // Closed around the move, so each one is its own undo step and does not merge with typing or another move.
  const tr = closeHistory(state.tr.replaceWith(from, to, swapped));
  tr.setSelection(TextSelection.create(tr.doc, anchor + shift, head + shift));
  view.dispatch(closeHistory(tr.scrollIntoView()));
  return true;
}

const CELLS = new Set(["tableCell", "tableHeader"]);

/** Swaps the table column under the cursor with the one beside it, in every row; false outside a table. */
function moveColumn(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view;
  const { $from, anchor, head } = state.selection;

  let depth = $from.depth;
  while (depth > 2 && !CELLS.has($from.node(depth).type.name)) depth--;
  if (!CELLS.has($from.node(depth).type.name)) return false;

  const table = $from.node(depth - 2);
  const column = $from.index(depth - 1);
  const other = column + direction;
  if (other < 0 || table.childCount === 0) return true;
  if (table.content.content.some((row) => other >= row.childCount)) return true;

  const rows = table.content.content.map((row) => {
    const cells = [...row.content.content];
    [cells[column], cells[other]] = [cells[other], cells[column]];
    return row.type.create(row.attrs, cells, row.marks);
  });
  const row = table.child($from.index(depth - 2));
  const neighbour = row.child(other);
  const start = $from.before(depth - 2);
  // The cursor travels with its cell, one neighbouring cell's width.
  const shift = direction * neighbour.nodeSize;

  const tr = closeHistory(
    state.tr.replaceWith(start, start + table.nodeSize, table.type.create(table.attrs, rows, table.marks)),
  );
  const inCell = (pos: number) => pos >= $from.start(depth) && pos <= $from.end(depth);
  const selection =
    inCell(anchor) && inCell(head)
      ? TextSelection.create(tr.doc, anchor + shift, head + shift)
      : TextSelection.near(tr.doc.resolve(head + shift));
  tr.setSelection(selection);
  view.dispatch(closeHistory(tr.scrollIntoView()));
  return true;
}

/**
 * ⇧⌘J / ⇧⌘K (or ⇧⌘↓ / ⇧⌘↑) move the block, table row or list item under the cursor down / up; in a table, ⇧⌘H / ⇧⌘L
 * (or ⇧⌘← / ⇧⌘→) move its column left / right.
 */
export const MoveBlock = Extension.create({
  name: "moveBlock",
  // Ahead of Vim, which in normal mode takes every letter, ⌘ or not.
  priority: 1000,
  // A plugin, not `addKeyboardShortcuts`: with ⌘ held the browser reports a letter in lower case whatever Shift does,
  // and the keymap then never matches a "Shift-" binding for it.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return false;
            switch (event.key.toLowerCase()) {
              case "j":
              case "arrowdown":
                return move(view, 1);
              case "k":
              case "arrowup":
                return move(view, -1);
              case "h":
              case "arrowleft":
                return moveColumn(view, -1);
              case "l":
              case "arrowright":
                return moveColumn(view, 1);
              default:
                return false;
            }
          },
        },
      }),
    ];
  },
});
