import { NodeSelection, Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { scroller } from "./cursor";

export type LineNumbers = "off" | "absolute" | "relative";

/** The gutter's width in px (`.vim-lines` is 2.5rem). */
const GUTTER = 40;
/** The height a divider's number is drawn over, px. */
const LINE = 24;

interface Row {
  top: number;
  bottom: number;
  /** Where its block starts, on the block's first row only (-1 on the rest). */
  from: number;
}

/** The screen lines of an element's content: its text's boxes, those overlapping vertically being one line. */
function screenRows(element: HTMLElement): { top: number; bottom: number }[] {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = [...range.getClientRects()]
    .filter((r) => r.height > 0)
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const found: { top: number; bottom: number }[] = [];
  for (const rect of rects) {
    const last = found[found.length - 1];
    if (last && rect.top < last.bottom - 1) last.bottom = Math.max(last.bottom, rect.bottom);
    else found.push({ top: rect.top, bottom: rect.bottom });
  }
  if (found.length) return found;
  const box = element.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || box.height;
  return [{ top: box.top, bottom: box.top + Math.min(box.height, lineHeight) }];
}

/** Every line of the page as Vim moves over it: a screen line of a textblock, or a table's row (its first line). */
function pageRows(view: EditorView): Row[] {
  const rows: Row[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "horizontalRule") {
      const box = (view.nodeDOM(pos) as HTMLElement | null)?.getBoundingClientRect();
      if (box) {
        // A divider is a thin line: its number sits on a line's height around it.
        const middle = (box.top + box.bottom) / 2;
        rows.push({ top: middle - LINE / 2, bottom: middle + LINE / 2, from: pos });
      }
      return false;
    }
    const isRow = node.type.name === "tableRow";
    if (!isRow && !node.isTextblock) return true;
    const dom = view.domAtPos(pos + 1).node;
    const element = dom instanceof HTMLElement ? dom : dom.parentElement;
    if (element && view.dom.contains(element)) {
      const lines = screenRows(element);
      // A table row is one line, as tall as its first cell's first line; the rest of a block is one per screen line.
      const shown = isRow ? lines.slice(0, 1) : lines;
      for (const [i, line] of shown.entries()) rows.push({ ...line, from: i ? -1 : pos });
    }
    return false;
  });
  return rows;
}

/**
 * Line numbers at the page's left or right border, one per screen line (a wrapped paragraph has several) and one per table
 * row: absolute, or relative to the cursor's line with the cursor's own line absolute, as Vim's `relativenumber` with
 * `number`. Drawn over the page like Vim's cursor (`.vim-lines` in `editor.css`).
 */
export function vimLines(mode: () => LineNumbers, side: () => "left" | "right") {
  return new Plugin({
    view(view) {
      const host = view.dom.parentElement;
      const gutter = document.createElement("div");
      gutter.className = "vim-lines";
      gutter.setAttribute("aria-hidden", "true");
      host?.appendChild(gutter);
      let frame = 0;

      const draw = () => {
        frame = 0;
        const shown = mode();
        if (!host || shown === "off") {
          gutter.replaceChildren();
          return;
        }
        const origin = host.getBoundingClientRect();
        const area = scroller(view);
        const edge = area.getBoundingClientRect().left;
        gutter.dataset.side = side();
        // The gutter is 2.5rem wide, at the page's border (the right one inside its scrollbar).
        gutter.style.left = `${(side() === "left" ? edge : edge + area.clientWidth - GUTTER) - origin.left}px`;
        const rows = pageRows(view);
        const head = view.coordsAtPos(view.state.selection.head, 1);
        const middle = (head.top + head.bottom) / 2;
        const { selection } = view.state;
        let at =
          selection instanceof NodeSelection
            ? rows.findIndex((r) => r.from === selection.from)
            : rows.findIndex((r) => middle >= r.top && middle <= r.bottom);
        // A cursor inside a table row's other cells is on that row.
        if (at < 0) {
          const pos = view.state.selection.head;
          at = Math.max(
            0,
            rows.findLastIndex((r) => r.from >= 0 && r.from < pos),
          );
        }
        const $head = view.state.doc.resolve(view.state.selection.head);
        for (let d = $head.depth; d > 0; d--) {
          if ($head.node(d).type.name !== "tableRow") continue;
          const index = rows.findIndex((r) => r.from === $head.before(d));
          if (index >= 0) at = index;
          break;
        }
        gutter.replaceChildren(
          ...rows.map((row, i) => {
            const div = document.createElement("div");
            div.textContent = String(shown === "relative" && i !== at ? Math.abs(i - at) : i + 1);
            if (i === at) div.dataset.current = "";
            div.style.top = `${row.top - origin.top}px`;
            div.style.height = `${row.bottom - row.top}px`;
            div.style.lineHeight = `${row.bottom - row.top}px`;
            return div;
          }),
        );
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(draw);
      };

      const resize = new ResizeObserver(schedule);
      resize.observe(view.dom);
      schedule();
      return {
        update: schedule,
        destroy() {
          resize.disconnect();
          cancelAnimationFrame(frame);
          gutter.remove();
        },
      };
    },
  });
}
