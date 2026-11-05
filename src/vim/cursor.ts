import { getMarkRange } from "@tiptap/core";
import { type EditorState, Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { vimPluginKey } from "./vendor";

/** The element the page scrolls in: the editor's nearest ancestor that scrolls vertically. */
export function scroller(view: EditorView): HTMLElement {
  for (let at = view.dom.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return document.documentElement;
}

interface Glide {
  target: number;
  /** What the glide last set, to notice a wheel or a scrollbar taking over. */
  last: number;
  frame: number;
}

const glides = new WeakMap<HTMLElement, Glide>();
/** The share of the remaining distance covered each frame. */
const EASE = 0.22;

/** Where the page is scrolling to: the end of a glide under way, else where it is. */
export function scrollTarget(area: HTMLElement) {
  return glides.get(area)?.target ?? area.scrollTop;
}

/**
 * Scrolls smoothly to `top`. A second call while a glide runs moves its end, so keys held or pressed in quick
 * succession keep one motion going rather than starting over.
 */
export function glideTo(area: HTMLElement, top: number) {
  const target = Math.max(0, Math.min(area.scrollHeight - area.clientHeight, top));
  const running = glides.get(area);
  if (running) {
    running.target = target;
    return;
  }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    area.scrollTop = target;
    return;
  }
  const glide: Glide = { target, last: area.scrollTop, frame: 0 };
  glides.set(area, glide);
  const step = () => {
    const diff = glide.target - area.scrollTop;
    if (Math.abs(area.scrollTop - glide.last) > 2 || Math.abs(diff) < 1) {
      if (Math.abs(diff) < 1) area.scrollTop = glide.target;
      glides.delete(area);
      return;
    }
    area.scrollTop += Math.sign(diff) * Math.max(1, Math.abs(diff) * EASE);
    glide.last = area.scrollTop;
    glide.frame = requestAnimationFrame(step);
  };
  glide.frame = requestAnimationFrame(step);
}

/** Where Vim's cursor is: the moving end of a visual selection, else the caret. */
export function head(view: EditorView) {
  return headOf(view.state);
}

function headOf(state: EditorState) {
  const vim = vimPluginKey.getState(state);
  return vim?.mode.startsWith("visual") ? (vim.visualHead ?? state.selection.head) : state.selection.head;
}

const OPERATORS = new Set(["d", "c", "y"]);

function shapeOf(state: EditorState) {
  const vim = vimPluginKey.getState(state);
  if (!vim) return null;
  if (vim.mode === "insert") return "bar";
  return vim.pendingOperator && OPERATORS.has(vim.pendingOperator) ? "underline" : "block";
}

/** The link the character at `pos` is in, as Vim steps over it: one block, like a mention. */
export function linkAt(state: EditorState, pos: number) {
  const type = state.schema.marks.link;
  const $pos = state.doc.resolve(pos);
  if (!type || !$pos.nodeAfter?.isText || !type.isInSet($pos.nodeAfter.marks)) return null;
  return getMarkRange($pos, type) ?? null;
}

/**
 * Outside insert mode a link is one block: a motion that lands inside one goes on to its end moving right (or stays on
 * it at a line's end), back to its start moving left.
 */
function skipLinks(transactions: readonly Transaction[], previous: EditorState, state: EditorState) {
  if (!transactions.some((tr) => tr.selectionSet)) return null;
  const vim = vimPluginKey.getState(state);
  if (vim?.mode !== "normal" || !state.selection.empty) return null;
  const pos = state.selection.head;
  const link = linkAt(state, pos);
  if (!link || link.from === pos) return null;
  const moved = transactions.some((tr) => tr.docChanged) ? pos : previous.selection.head;
  // `e` lands on a link's last character, from outside it: the link is the word's end, so the block, not past it.
  const entered = pos === link.to - 1 && (moved < link.from || moved >= link.to);
  const end = !entered && link.to < state.doc.resolve(pos).end() && pos > moved ? link.to : link.from;
  return state.tr.setSelection(TextSelection.create(state.doc, end));
}

/** An inline node (a mention, an emoji) under the block cursor, marked to drop its own selected look for the block's. */
function under(state: EditorState) {
  if (shapeOf(state) !== "block") return DecorationSet.empty;
  const pos = headOf(state);
  const after = state.doc.resolve(pos).nodeAfter;
  if (!after?.isInline || after.isText) return DecorationSet.empty;
  return DecorationSet.create(state.doc, [Decoration.node(pos, pos + after.nodeSize, { class: "vim-cursor-node" })]);
}
/** The thinnest the block cursor gets, as a share of the line's height. */
const MIN_WIDTH = 0.3;
/** How far the block reaches past an inline node (a mention, an emoji) on each side, in pixels. */
const NODE_PAD = { x: 3, y: 1 };

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The first or last text inside an element, however deep (decorations wrap it in spans). */
function edgeText(element: Element, which: "first" | "last") {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return which === "first" ? walker.firstChild() : walker.lastChild();
}

let inkContext: CanvasRenderingContext2D | null | undefined;

/**
 * The box of the character after `pos`, as the browser lays it out, widened to its ink where a glyph overhangs its
 * advance (a bold `T` or `W`, kerned over its neighbour); null when it is not in a text node.
 */
function characterBox(view: EditorView, pos: number) {
  const { node, offset } = view.domAtPos(pos, 1);
  if (node.nodeType !== Node.TEXT_NODE || offset >= (node.textContent?.length ?? 0)) return null;
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  const rect = range.getBoundingClientRect();
  let { left, right } = rect;
  const parent = node.parentElement;
  inkContext ??= document.createElement("canvas").getContext("2d");
  if (inkContext && parent) {
    // The `font` shorthand reads back empty when the element sets feature settings: put it together from its parts.
    const style = getComputedStyle(parent);
    inkContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const ink = inkContext.measureText(node.textContent?.[offset] ?? "");
    left = Math.min(left, rect.left - ink.actualBoundingBoxLeft);
    right = Math.max(right, rect.left + ink.actualBoundingBoxRight);
  }
  return { left, width: right - left, top: rect.top };
}

/**
 * Where a textblock's lines lie on the screen: the top of its first and the height of each. Measured on the block's
 * content, inside whatever its node view wraps it in (the title's carries the icon and the properties); text outside
 * any textblock's content has no lines to select.
 */
function lineGrid(view: EditorView, text: Node) {
  const $pos = view.state.doc.resolve(view.posAtDOM(text, 0));
  const block = $pos.parent.isTextblock ? view.domAtPos($pos.start()).node : null;
  if (!(block instanceof HTMLElement) || !block.contains(text)) return null;
  // A code block's content is the inline `code` inside its `pre`: its lines start where the `pre`'s do.
  const box = getComputedStyle(block).display === "inline" ? (block.parentElement ?? block) : block;
  const style = getComputedStyle(box);
  const top =
    box.getBoundingClientRect().top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
  return { top, height: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.6 };
}

/**
 * The selection as one box per screen line, from its first selected character to its last, exactly as tall as the
 * line (snapped to the textblock's lines, whatever font the characters are in): the browser's own highlight leaves
 * holes around inline code and changes height with it. Inline code selected up to its edge is covered with its
 * padding.
 */
function selectionBoxes(view: EditorView): Box[] {
  const { from, to, empty } = view.state.selection;
  // Selected table cells are painted by `.selectedCell`.
  if (empty || view.state.selection instanceof CellSelection) return [];
  const range = document.createRange();
  const start = view.domAtPos(from);
  const end = view.domAtPos(to);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const lines = new Map<number, Box>();
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  const piece = document.createRange();
  for (let node = walker.currentNode as Node | null; node; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
    const grid = lineGrid(view, node);
    if (!grid) continue;
    const length = node.textContent?.length ?? 0;
    const first = node === range.startContainer ? range.startOffset : 0;
    const last = node === range.endContainer ? range.endOffset : length;
    piece.setStart(node, first);
    piece.setEnd(node, last);
    const rects = [...piece.getClientRects()]
      .filter((r) => r.width > 0)
      .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    const code = node.parentElement?.closest("code");
    if (code && rects.length) {
      const edges = code.getClientRects();
      const [head, tail] = [rects[0], rects[rects.length - 1]];
      const [open, close] = [edges[0], edges[edges.length - 1]];
      if (head && open && first === 0 && node === edgeText(code, "first")) head.left = Math.min(head.left, open.left);
      if (tail && close && last === length && node === edgeText(code, "last"))
        tail.right = Math.max(tail.right, close.right);
    }
    for (const rect of rects) {
      const index = Math.floor(((rect.top + rect.bottom) / 2 - grid.top) / grid.height);
      const top = grid.top + index * grid.height;
      const key = Math.round(top);
      const line = lines.get(key);
      if (!line) lines.set(key, { top, bottom: top + grid.height, left: rect.left, right: rect.right });
      else {
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
      }
    }
  }
  return [...lines.values()];
}

/**
 * Vim's cursor, drawn over the text instead of the browser's caret: a block in normal and visual mode, an underline
 * while an operator (`d`, `c`, `y`) waits for its motion, a bar in insert mode. It glides to where it moves (CSS on
 * `.vim-cursor`), and the page scrolls to keep `scrolloff()` lines around it. The block is drawn behind the text, so
 * the character under it stays as it is; one timer blinks it, through `data-vim-blink` on the host.
 */
/** A cursor shown on a block still coming in (`stream.ts`'s `appear`) comes in with it, in step. */
function comeInWith(view: EditorView, pos: number, cursor: HTMLElement) {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.depth) return;
  const block = view.nodeDOM($pos.before(1));
  const coming = block instanceof HTMLElement ? block.getAnimations()[0] : undefined;
  if (!coming?.effect || coming.playState === "finished") return;
  const motion = cursor.animate(
    [
      { opacity: 0, translate: "0 4px" },
      { opacity: 1, translate: "0 0" },
    ],
    coming.effect.getTiming(),
  );
  motion.currentTime = coming.currentTime;
}

export function vimCursor(scrolloff: () => number) {
  return new Plugin({
    props: { decorations: under },
    appendTransaction: skipLinks,
    view(view) {
      const cursor = document.createElement("div");
      cursor.className = "vim-cursor";
      cursor.setAttribute("aria-hidden", "true");
      const host = view.dom.parentElement;
      // Its own stacking context, for the cursor to sit under the text but over the page's background.
      if (host) host.style.isolation = "isolate";
      host?.appendChild(cursor);
      const selection = document.createElement("div");
      selection.className = "vim-selection";
      selection.setAttribute("aria-hidden", "true");
      host?.appendChild(selection);

      const drawSelection = () => {
        const boxes = host && view.hasFocus() ? selectionBoxes(view) : [];
        const origin = host?.getBoundingClientRect();
        selection.replaceChildren(
          ...boxes.map((box) => {
            const div = document.createElement("div");
            div.className = "vim-selection-box";
            div.style.transform = `translate(${box.left - (origin?.left ?? 0)}px, ${box.top - (origin?.top ?? 0)}px)`;
            div.style.width = `${box.right - box.left}px`;
            div.style.height = `${box.bottom - box.top}px`;
            return div;
          }),
        );
      };
      let last = "";
      let blink = 0;
      // Solid while it moves, like an editor's: the blink starts over.
      const restartBlink = () => {
        if (!host) return;
        host.dataset.vimBlink = "on";
        clearInterval(blink);
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        blink = window.setInterval(() => {
          host.dataset.vimBlink = host.dataset.vimBlink === "on" ? "off" : "on";
        }, 550);
      };

      const draw = () => {
        drawSelection();
        const vim = vimPluginKey.getState(view.state);
        // Not while the page slides in: it comes in where the text lands, once it has.
        if (!vim || !host || !view.hasFocus() || "appearing" in view.dom.dataset) {
          cursor.hidden = true;
          return;
        }
        const appearing = cursor.hidden;
        cursor.hidden = false;
        const pos = head(view);
        const start = view.coordsAtPos(pos, 1);
        const box = host.getBoundingClientRect();
        const height = start.bottom - start.top;
        // The character's width, but never thinner than `MIN_WIDTH` of the line: a narrow one (`i`, `l`) is padded
        // evenly on both sides, centred on it. Past a line's end there is no character, so a fixed block.
        let left = start.left;
        let width = height * 0.5;
        const $pos = view.state.doc.resolve(pos);
        if ($pos.parent.isTextblock && pos < $pos.end()) {
          // The character's own box, not the gap to the next one's caret: in a large heading the two differ.
          const glyph = characterBox(view, pos);
          if (glyph && Math.abs(glyph.top - start.top) < height / 2 && glyph.width > 0) {
            width = Math.max(glyph.width, height * MIN_WIDTH);
            left = glyph.left - (width - glyph.width) / 2;
          }
        }
        const shape = shapeOf(view.state) ?? "block";
        cursor.dataset.shape = shape;
        // An inline node gets a block a little larger than itself.
        const link = shape === "block" ? linkAt(view.state, pos) : null;
        if (link) {
          // A link the cursor is on is covered whole, its icon too, when it fits on one line.
          const { node } = view.domAtPos(link.from + 1);
          const rects = (node instanceof Element ? node : node.parentElement)?.closest("a.link")?.getClientRects();
          if (rects?.length === 1) {
            left = rects[0].left;
            width = rects[0].width;
          }
        }
        const atom = shape === "block" && !link && $pos.nodeAfter?.isInline && !$pos.nodeAfter.isText;
        if (atom) {
          // A mention (or other inline node) is one symbol: covered whole, icon and name, when it fits on one line.
          const rects = (view.nodeDOM(pos) as Element | null)?.getClientRects?.();
          if (rects?.length === 1) {
            left = rects[0].left;
            width = rects[0].width;
          }
        }
        const onNode = shape === "block" && (!!link || (!$pos.nodeAfter?.isText && !!$pos.nodeAfter?.isInline));
        const pad = onNode ? NODE_PAD : { x: 0, y: 0 };
        cursor.dataset.onNode = String(onNode);
        if (appearing) cursor.style.transition = "none";
        cursor.style.transform = `translate(${(shape === "bar" ? start.left : left - pad.x) - box.left}px, ${start.top - pad.y - box.top}px)`;
        if (appearing) {
          void cursor.offsetWidth;
          cursor.style.transition = "";
          comeInWith(view, pos, cursor);
        }
        cursor.style.width = `${shape === "bar" ? 2 : width + 2 * pad.x}px`;
        cursor.style.height = `${height + 2 * pad.y}px`;
        const at = `${pos}:${shape}`;
        if (at !== last) restartBlink();
        last = at;
      };

      const keepInView = () => {
        const lines = scrolloff();
        if (!lines || !view.hasFocus()) return;
        const area = scroller(view);
        const rect =
          area === document.documentElement ? new DOMRect(0, 0, innerWidth, innerHeight) : area.getBoundingClientRect();
        const line = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 24;
        const margin = Math.min(lines * line, (rect.height - line) / 2);
        // Measured against where the page is gliding to, not where it is on the way there.
        const target = scrollTarget(area);
        const shift = target - area.scrollTop;
        const at = view.coordsAtPos(head(view));
        const top = at.top - shift;
        const bottom = at.bottom - shift;
        if (top - margin < rect.top) glideTo(area, target - (rect.top - (top - margin)));
        else if (bottom + margin > rect.bottom) glideTo(area, target + (bottom + margin - rect.bottom));
      };

      const resize = new ResizeObserver(draw);
      resize.observe(view.dom);
      view.dom.addEventListener("focus", draw);
      view.dom.addEventListener("blur", draw);
      draw();
      return {
        update(next, previous) {
          if (!next.state.selection.eq(previous.selection) || next.state.doc !== previous.doc) keepInView();
          draw();
        },
        destroy() {
          resize.disconnect();
          clearInterval(blink);
          if (host) delete host.dataset.vimBlink;
          view.dom.removeEventListener("focus", draw);
          view.dom.removeEventListener("blur", draw);
          cursor.remove();
          selection.remove();
        },
      };
    },
  });
}
