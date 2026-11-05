// src/vimExtension.ts
import { Extension } from "@tiptap/core";
import { Plugin as Plugin2 } from "@tiptap/pm/state";

// src/state/vimState.ts
import { PluginKey } from "@tiptap/pm/state";
var vimPluginKey = new PluginKey("tiptap-vim");
var initialVimState = {
  mode: "normal",
  keyBuffer: "",
  count: null,
  pendingOperator: null,
  operatorCount: null,
  visualAnchor: null,
  visualHead: null,
  desiredColumn: null,
  pendingFind: null,
  lastFind: null
};

// src/state/registers.ts
var RegisterManager = class {
  constructor() {
    this.defaultRegister = null;
  }
  set(entry) {
    this.defaultRegister = entry;
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(entry.text).catch(() => {
      });
    }
  }
  get() {
    return this.defaultRegister;
  }
};
var registers = new RegisterManager();

// src/ui/cursorPlugin.ts
import { Plugin, PluginKey as PluginKey2 } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
var vimCursorPluginKey = new PluginKey2("vim-cursor-plugin");
function createCursorPlugin() {
  return new Plugin({
    key: vimCursorPluginKey,
    props: {
      decorations(state) {
        const vimState = vimPluginKey.getState(state);
        if (!vimState || vimState.mode !== "normal") {
          return DecorationSet.empty;
        }
        const { selection } = state;
        if (!selection.empty) {
          return DecorationSet.empty;
        }
        const pos = selection.from;
        const $pos = state.doc.resolve(pos);
        if (!$pos.parent.isTextblock) {
          const widget2 = Decoration.widget(pos, () => {
            const span = document.createElement("span");
            span.className = "vim-cursor-block vim-cursor-empty";
            span.innerHTML = "&nbsp;";
            return span;
          });
          return DecorationSet.create(state.doc, [widget2]);
        }
        const blockEnd = $pos.end();
        if (pos < blockEnd) {
          try {
            const dec = Decoration.inline(pos, pos + 1, {
              class: "vim-cursor-block"
            });
            return DecorationSet.create(state.doc, [dec]);
          } catch {
          }
        }
        const widget = Decoration.widget(pos, () => {
          const span = document.createElement("span");
          span.className = "vim-cursor-block vim-cursor-empty";
          span.innerHTML = "&nbsp;";
          return span;
        });
        return DecorationSet.create(state.doc, [widget]);
      }
    }
  });
}

// src/input/keyDispatcher.ts
import { TextSelection as TextSelection2 } from "@tiptap/pm/state";

// src/motions/charMotions.ts
function moveLeft(state, pos, count = 1) {
  const $pos = state.doc.resolve(pos);
  const blockStart = $pos.start();
  return Math.max(blockStart, pos - count);
}
function moveRight(state, pos, count = 1, mode = "normal") {
  const $pos = state.doc.resolve(pos);
  const blockStart = $pos.start();
  const blockEnd = $pos.end();
  if (blockStart === blockEnd) {
    return blockStart;
  }
  const maxPos = mode === "visual" || mode === "visual-line" ? blockEnd : blockEnd - 1;
  return Math.min(Math.max(blockStart, maxPos), pos + count);
}
function moveToLineStart(state, pos) {
  const $pos = state.doc.resolve(pos);
  return $pos.start();
}
function moveToFirstNonWhitespace(state, pos) {
  const $pos = state.doc.resolve(pos);
  const blockStart = $pos.start();
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
  const match = text.search(/\S/);
  if (match === -1) {
    return blockStart;
  }
  return blockStart + match;
}
function moveToLineEnd(state, pos, mode = "normal") {
  const $pos = state.doc.resolve(pos);
  const blockStart = $pos.start();
  const blockEnd = $pos.end();
  if (blockStart === blockEnd) {
    return blockStart;
  }
  if (mode === "visual" || mode === "visual-line") {
    return blockEnd;
  }
  return blockEnd - 1;
}
function findCharInLine(state, pos, type, char, count = 1) {
  const $pos = state.doc.resolve(pos);
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
  const offset = $pos.parentOffset;
  const blockStart = $pos.start();
  if (type === "f" || type === "t") {
    let matches = 0;
    for (let i = offset + 1; i < text.length; i++) {
      if (text[i] === char) {
        matches++;
        if (matches === count) {
          const targetOffset = type === "t" ? i - 1 : i;
          return blockStart + Math.max(offset, targetOffset);
        }
      }
    }
  } else if (type === "F" || type === "T") {
    let matches = 0;
    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === char) {
        matches++;
        if (matches === count) {
          const targetOffset = type === "T" ? i + 1 : i;
          return blockStart + Math.min(offset, targetOffset);
        }
      }
    }
  }
  return null;
}
var BRACKET_PAIRS = {
  "(": { match: ")", dir: 1 },
  ")": { match: "(", dir: -1 },
  "[": { match: "]", dir: 1 },
  "]": { match: "[", dir: -1 },
  "{": { match: "}", dir: 1 },
  "}": { match: "{", dir: -1 }
};
function matchBracket(state, pos) {
  const $pos = state.doc.resolve(pos);
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
  let offset = $pos.parentOffset;
  const blockStart = $pos.start();
  let bracketChar = text[offset];
  if (!BRACKET_PAIRS[bracketChar]) {
    let found = -1;
    for (let i = offset + 1; i < text.length; i++) {
      if (BRACKET_PAIRS[text[i]]) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    offset = found;
    bracketChar = text[offset];
  }
  const { match, dir } = BRACKET_PAIRS[bracketChar];
  let depth = 1;
  let cur = offset + dir;
  while (cur >= 0 && cur < text.length) {
    if (text[cur] === bracketChar) {
      depth++;
    } else if (text[cur] === match) {
      depth--;
      if (depth === 0) {
        return blockStart + cur;
      }
    }
    cur += dir;
  }
  return null;
}

// src/motions/wordMotions.ts
function classifyChar(ch) {
  if (/\s/.test(ch)) return 0 /* Whitespace */;
  if (/\w/.test(ch)) return 1 /* Word */;
  return 2 /* Punctuation */;
}
function getNextBlockStart(state, pos) {
  const $pos = state.doc.resolve(pos);
  const after = $pos.after();
  if (after < state.doc.content.size) {
    let target = null;
    state.doc.nodesBetween(after, state.doc.content.size, (node, p) => {
      if (target !== null) return false;
      if (node.isTextblock) {
        target = p + 1;
        return false;
      }
    });
    return target;
  }
  return null;
}
function getPrevBlockEnd(state, pos) {
  const $pos = state.doc.resolve(pos);
  const before = $pos.before();
  if (before > 0) {
    let target = null;
    state.doc.nodesBetween(0, before, (node, p) => {
      if (node.isTextblock && p + node.nodeSize <= before) {
        const textLen = node.textBetween(0, node.content.size, "\n", "\uFFFC").length;
        target = p + 1 + Math.max(0, textLen - 1);
      }
    });
    return target;
  }
  return null;
}
function moveWordForward(state, pos, count = 1) {
  let currentPos = pos;
  for (let i = 0; i < count; i++) {
    const $pos = state.doc.resolve(currentPos);
    const blockEnd = $pos.end();
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
    let offset = $pos.parentOffset;
    if (offset >= text.length) {
      const nextStart = getNextBlockStart(state, currentPos);
      if (nextStart !== null) {
        currentPos = nextStart;
      }
      continue;
    }
    const startClass = classifyChar(text[offset]);
    if (startClass !== 0 /* Whitespace */) {
      while (offset < text.length && classifyChar(text[offset]) === startClass) {
        offset++;
      }
    }
    while (offset < text.length && classifyChar(text[offset]) === 0 /* Whitespace */) {
      offset++;
    }
    if (offset >= text.length) {
      const nextStart = getNextBlockStart(state, currentPos);
      if (nextStart !== null) {
        currentPos = nextStart;
      } else {
        currentPos = blockEnd - (text.length > 0 ? 1 : 0);
      }
    } else {
      currentPos = $pos.start() + offset;
    }
  }
  return currentPos;
}
function moveWordBackward(state, pos, count = 1) {
  let currentPos = pos;
  for (let i = 0; i < count; i++) {
    const $pos = state.doc.resolve(currentPos);
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
    let offset = $pos.parentOffset;
    if (offset <= 0) {
      const prevEnd = getPrevBlockEnd(state, currentPos);
      if (prevEnd !== null) {
        currentPos = prevEnd;
      }
      continue;
    }
    offset--;
    while (offset > 0 && classifyChar(text[offset]) === 0 /* Whitespace */) {
      offset--;
    }
    const targetClass = classifyChar(text[offset]);
    if (targetClass !== 0 /* Whitespace */) {
      while (offset > 0 && classifyChar(text[offset - 1]) === targetClass) {
        offset--;
      }
    }
    currentPos = $pos.start() + offset;
  }
  return currentPos;
}
function moveWordEnd(state, pos, count = 1) {
  let currentPos = pos;
  for (let i = 0; i < count; i++) {
    const $pos = state.doc.resolve(currentPos);
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
    let offset = $pos.parentOffset;
    let $at = $pos;
    let line = text;
    let from = offset + 1;
    if (offset >= text.length - 1) {
      const nextStart = getNextBlockStart(state, currentPos);
      if (nextStart === null) continue;
      $at = state.doc.resolve(nextStart);
      line = $at.parent.textBetween(0, $at.parent.content.size, "\n", "\uFFFC");
      from = 0;
    }
    offset = from;
    while (offset < line.length && classifyChar(line[offset]) === 0 /* Whitespace */) {
      offset++;
    }
    if (offset >= line.length) {
      currentPos = $at.start() + Math.max(0, line.length - 1);
      continue;
    }
    const targetClass = classifyChar(line[offset]);
    while (offset < line.length - 1 && classifyChar(line[offset + 1]) === targetClass) {
      offset++;
    }
    currentPos = $at.start() + offset;
  }
  return currentPos;
}
function moveBigWordForward(state, pos, count = 1) {
  let currentPos = pos;
  for (let i = 0; i < count; i++) {
    const $pos = state.doc.resolve(currentPos);
    const blockEnd = $pos.end();
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
    let offset = $pos.parentOffset;
    if (offset >= text.length) {
      const nextStart = getNextBlockStart(state, currentPos);
      if (nextStart !== null) {
        currentPos = nextStart;
      }
      continue;
    }
    while (offset < text.length && !/\s/.test(text[offset])) {
      offset++;
    }
    while (offset < text.length && /\s/.test(text[offset])) {
      offset++;
    }
    if (offset >= text.length) {
      const nextStart = getNextBlockStart(state, currentPos);
      if (nextStart !== null) {
        currentPos = nextStart;
      } else {
        currentPos = blockEnd - (text.length > 0 ? 1 : 0);
      }
    } else {
      currentPos = $pos.start() + offset;
    }
  }
  return currentPos;
}
function moveBigWordBackward(state, pos, count = 1) {
  let currentPos = pos;
  for (let i = 0; i < count; i++) {
    const $pos = state.doc.resolve(currentPos);
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
    let offset = $pos.parentOffset;
    if (offset <= 0) {
      const prevEnd = getPrevBlockEnd(state, currentPos);
      if (prevEnd !== null) {
        currentPos = prevEnd;
      }
      continue;
    }
    offset--;
    while (offset > 0 && /\s/.test(text[offset])) {
      offset--;
    }
    while (offset > 0 && !/\s/.test(text[offset - 1])) {
      offset--;
    }
    currentPos = $pos.start() + offset;
  }
  return currentPos;
}
function moveBigWordEnd(state, pos, count = 1) {
  let currentPos = pos;
  for (let i = 0; i < count; i++) {
    const $pos = state.doc.resolve(currentPos);
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC");
    let offset = $pos.parentOffset;
    if (offset >= text.length - 1) {
      const nextStart = getNextBlockStart(state, currentPos);
      if (nextStart !== null) {
        currentPos = nextStart;
      }
      continue;
    }
    offset++;
    while (offset < text.length && /\s/.test(text[offset])) {
      offset++;
    }
    while (offset < text.length - 1 && !/\s/.test(text[offset + 1])) {
      offset++;
    }
    currentPos = $pos.start() + offset;
  }
  return currentPos;
}

// src/motions/lineMotions.ts
function getAllTextBlocks(doc) {
  const blocks = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const start = pos + 1;
      const end = pos + node.nodeSize - 1;
      blocks.push({ start, end, node });
    }
  });
  return blocks;
}
function findBlockIndex(blocks, pos) {
  if (blocks.length === 0) return -1;
  for (let i = 0; i < blocks.length; i++) {
    if (pos >= blocks[i].start && pos <= blocks[i].end) {
      return i;
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (pos >= blocks[i].end) {
      return i;
    }
  }
  return 0;
}
function clampToBlock(block, pos) {
  const textLen = block.node.textBetween(0, block.node.content.size, "\n", "\uFFFC").length;
  if (textLen === 0) {
    return block.start;
  }
  const maxPos = block.start + textLen - 1;
  return Math.min(Math.max(block.start, pos), maxPos);
}
function moveDown(view, state, pos, count = 1, desiredColumn = null) {
  const blocks = getAllTextBlocks(state.doc);
  if (blocks.length === 0) {
    return { pos, column: 0 };
  }
  let blockIdx = findBlockIndex(blocks, pos);
  let currentPos = clampToBlock(blocks[blockIdx], pos);
  let activeColumn = desiredColumn;
  for (let c = 0; c < count; c++) {
    const curBlock = blocks[blockIdx];
    let nextPos = null;
    if (view && typeof view.coordsAtPos === "function") {
      try {
        const coords = view.coordsAtPos(currentPos);
        if (coords && coords.bottom > coords.top) {
          const colX = activeColumn ?? coords.left;
          activeColumn = colX;
          const lineHeight = Math.max(16, coords.bottom - coords.top);
          const targetY = coords.bottom + lineHeight / 2;
          const result = view.posAtCoords({ left: colX, top: targetY });
          if (result && result.pos >= curBlock.start && result.pos <= curBlock.end) {
            const newCoords = view.coordsAtPos(result.pos);
            if (newCoords && newCoords.top >= coords.bottom - 4) {
              nextPos = clampToBlock(curBlock, result.pos);
            }
          }
        }
      } catch {
      }
    }
    if (nextPos === null) {
      if (blockIdx < blocks.length - 1) {
        blockIdx++;
        const nextBlock = blocks[blockIdx];
        let landed = false;
        if (view && typeof view.coordsAtPos === "function" && activeColumn !== null) {
          try {
            const nextCoords = view.coordsAtPos(nextBlock.start);
            if (nextCoords && nextCoords.bottom > nextCoords.top) {
              const targetY = nextCoords.top + (nextCoords.bottom - nextCoords.top) / 2;
              const result = view.posAtCoords({ left: activeColumn, top: targetY });
              if (result && result.pos >= nextBlock.start && result.pos <= nextBlock.end) {
                nextPos = clampToBlock(nextBlock, result.pos);
                landed = true;
              }
            }
          } catch {
          }
        }
        if (!landed) {
          const $cur = state.doc.resolve(currentPos);
          const targetOffset = Math.min(nextBlock.node.content.size, $cur.parentOffset);
          nextPos = clampToBlock(nextBlock, nextBlock.start + targetOffset);
        }
      } else {
        break;
      }
    }
    if (nextPos !== null) {
      currentPos = nextPos;
    }
  }
  return { pos: currentPos, column: activeColumn ?? 0 };
}
function moveUp(view, state, pos, count = 1, desiredColumn = null) {
  const blocks = getAllTextBlocks(state.doc);
  if (blocks.length === 0) {
    return { pos, column: 0 };
  }
  let blockIdx = findBlockIndex(blocks, pos);
  let currentPos = clampToBlock(blocks[blockIdx], pos);
  let activeColumn = desiredColumn;
  for (let c = 0; c < count; c++) {
    const curBlock = blocks[blockIdx];
    let nextPos = null;
    if (view && typeof view.coordsAtPos === "function") {
      try {
        const coords = view.coordsAtPos(currentPos);
        if (coords && coords.bottom > coords.top) {
          const colX = activeColumn ?? coords.left;
          activeColumn = colX;
          const lineHeight = Math.max(16, coords.bottom - coords.top);
          const targetY = coords.top - lineHeight / 2;
          const result = view.posAtCoords({ left: colX, top: targetY });
          if (result && result.pos >= curBlock.start && result.pos <= curBlock.end) {
            const newCoords = view.coordsAtPos(result.pos);
            if (newCoords && newCoords.bottom <= coords.top + 4) {
              nextPos = clampToBlock(curBlock, result.pos);
            }
          }
        }
      } catch {
      }
    }
    if (nextPos === null) {
      if (blockIdx > 0) {
        blockIdx--;
        const prevBlock = blocks[blockIdx];
        let landed = false;
        if (view && typeof view.coordsAtPos === "function" && activeColumn !== null) {
          try {
            const prevEndPos = clampToBlock(prevBlock, prevBlock.end);
            const prevCoords = view.coordsAtPos(prevEndPos);
            if (prevCoords && prevCoords.bottom > prevCoords.top) {
              const targetY = prevCoords.top + (prevCoords.bottom - prevCoords.top) / 2;
              const result = view.posAtCoords({ left: activeColumn, top: targetY });
              if (result && result.pos >= prevBlock.start && result.pos <= prevBlock.end) {
                nextPos = clampToBlock(prevBlock, result.pos);
                landed = true;
              }
            }
          } catch {
          }
        }
        if (!landed) {
          const $cur = state.doc.resolve(currentPos);
          const targetOffset = Math.min(prevBlock.node.content.size, $cur.parentOffset);
          nextPos = clampToBlock(prevBlock, prevBlock.start + targetOffset);
        }
      } else {
        break;
      }
    }
    if (nextPos !== null) {
      currentPos = nextPos;
    }
  }
  return { pos: currentPos, column: activeColumn ?? 0 };
}
function jumpToTop(state, lineNumber = null) {
  const blocks = getAllTextBlocks(state.doc);
  if (blocks.length === 0) return 0;
  if (lineNumber !== null && lineNumber > 0) {
    const idx = Math.min(lineNumber - 1, blocks.length - 1);
    return clampToBlock(blocks[idx], blocks[idx].start);
  }
  return clampToBlock(blocks[0], blocks[0].start);
}
function jumpToBottom(state, lineNumber = null) {
  const blocks = getAllTextBlocks(state.doc);
  if (blocks.length === 0) return 0;
  if (lineNumber !== null && lineNumber > 0) {
    const idx = Math.min(lineNumber - 1, blocks.length - 1);
    return clampToBlock(blocks[idx], blocks[idx].start);
  }
  const last = blocks[blocks.length - 1];
  return clampToBlock(last, last.end);
}
function moveParagraphDown(state, pos, count = 1) {
  const blocks = getAllTextBlocks(state.doc);
  if (blocks.length === 0) return pos;
  const curIdx = findBlockIndex(blocks, pos);
  const targetIdx = Math.min(blocks.length - 1, curIdx + count);
  return clampToBlock(blocks[targetIdx], blocks[targetIdx].start);
}
function moveParagraphUp(state, pos, count = 1) {
  const blocks = getAllTextBlocks(state.doc);
  if (blocks.length === 0) return pos;
  const curIdx = findBlockIndex(blocks, pos);
  const targetIdx = Math.max(0, curIdx - count);
  return clampToBlock(blocks[targetIdx], blocks[targetIdx].start);
}

// src/operators/actions.ts
import { TextSelection } from "@tiptap/pm/state";
function deleteChar(ctx, count = 1) {
  const { state, dispatch, resetBuffer } = ctx;
  const { selection } = state;
  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const blockEnd = $pos.end();
  if (pos >= blockEnd) {
    resetBuffer();
    return;
  }
  const endPos = Math.min(blockEnd, pos + count);
  const deletedText = state.doc.textBetween(pos, endPos);
  registers.set({ text: deletedText, type: "char", slice: state.doc.slice(pos, endPos) });
  const tr = state.tr.delete(pos, endPos);
  const new$pos = tr.doc.resolve(pos);
  const newBlockEnd = new$pos.end();
  const newPos = Math.min(Math.max(new$pos.start(), newBlockEnd - 1), pos);
  tr.setSelection(TextSelection.create(tr.doc, Math.max(new$pos.start(), newPos)));
  dispatch(tr);
  resetBuffer();
}
function deleteLine(ctx, count = 1) {
  const { state, dispatch, resetBuffer } = ctx;
  const pos = state.selection.from;
  const $pos = state.doc.resolve(pos);
  let startBefore = $pos.before();
  let endAfter = $pos.after();
  let deletedText = $pos.parent.textBetween(0, $pos.parent.content.size, "\n") + "\n";
  let currentBlockEnd = endAfter;
  for (let i = 1; i < count; i++) {
    if (currentBlockEnd < state.doc.content.size) {
      const $next = state.doc.resolve(currentBlockEnd);
      deletedText += $next.parent.textBetween(0, $next.parent.content.size, "\n") + "\n";
      endAfter = $next.after();
      currentBlockEnd = endAfter;
    }
  }
  registers.set({ text: deletedText, type: "line", slice: state.doc.slice(startBefore, endAfter) });
  if (startBefore === 0 && endAfter >= state.doc.content.size) {
    const tr2 = state.tr.delete($pos.start(), $pos.end());
    tr2.setSelection(TextSelection.create(tr2.doc, $pos.start()));
    dispatch(tr2);
    resetBuffer();
    return;
  }
  const tr = state.tr.delete(startBefore, endAfter);
  const safePos = Math.min(startBefore + 1, tr.doc.content.size - 1);
  const safe$pos = tr.doc.resolve(Math.max(0, safePos));
  const targetPos = safe$pos.parent.isTextblock ? safe$pos.start() : safePos;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, targetPos))));
  dispatch(tr);
  resetBuffer();
}
function deleteRange(ctx, from, to, lineWise = false) {
  const { state, dispatch, resetBuffer } = ctx;
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end) {
    resetBuffer();
    return;
  }
  const deletedText = state.doc.textBetween(start, end);
  registers.set({ text: deletedText, type: lineWise ? "line" : "char", slice: state.doc.slice(start, end) });
  const tr = state.tr.delete(start, end);
  const $new = tr.doc.resolve(Math.min(start, tr.doc.content.size));
  const newPos = Math.min(Math.max($new.start(), $new.end() - 1), start);
  tr.setSelection(TextSelection.create(tr.doc, Math.max($new.start(), newPos)));
  dispatch(tr);
  resetBuffer();
}
function changeLine(ctx) {
  const { state, dispatch, updateVimState, resetBuffer } = ctx;
  const $pos = state.selection.$from;
  const blockStart = $pos.start();
  const blockEnd = $pos.end();
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n") + "\n";
  registers.set({ text, type: "line", slice: state.doc.slice($pos.before(), $pos.after()) });
  const tr = state.tr.delete(blockStart, blockEnd);
  tr.setSelection(TextSelection.create(tr.doc, blockStart));
  dispatch(tr);
  updateVimState({ mode: "insert" });
  resetBuffer();
}
function changeRange(ctx, from, to) {
  const { state, dispatch, updateVimState, resetBuffer } = ctx;
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const deletedText = state.doc.textBetween(start, end);
  registers.set({ text: deletedText, type: "char", slice: state.doc.slice(start, end) });
  const tr = state.tr.delete(start, end);
  tr.setSelection(TextSelection.create(tr.doc, start));
  dispatch(tr);
  updateVimState({ mode: "insert" });
  resetBuffer();
}
function yankLine(ctx, count = 1) {
  const { state, resetBuffer } = ctx;
  const $pos = state.selection.$from;
  let text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n") + "\n";
  let currentAfter = $pos.after();
  for (let i = 1; i < count; i++) {
    if (currentAfter < state.doc.content.size) {
      const $next = state.doc.resolve(currentAfter);
      text += $next.parent.textBetween(0, $next.parent.content.size, "\n") + "\n";
      currentAfter = $next.after();
    }
  }
  registers.set({ text, type: "line", slice: state.doc.slice($pos.before(), currentAfter) });
  if (typeof navigator !== "undefined") navigator.clipboard?.writeText(text).catch(() => {});
  resetBuffer();
}
function yankRange(ctx, from, to, lineWise = false) {
  const { state, resetBuffer } = ctx;
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const text = state.doc.textBetween(start, end);
  registers.set({ text, type: lineWise ? "line" : "char", slice: state.doc.slice(start, end) });
  if (typeof navigator !== "undefined") navigator.clipboard?.writeText(text).catch(() => {});
  resetBuffer();
}
function put(ctx, before = false) {
  const { state, dispatch, resetBuffer } = ctx;
  const entry = registers.get();
  if (!entry) {
    resetBuffer();
    return;
  }
  const $pos = state.selection.$from;
  const tr = state.tr;
  if (entry.type === "line" && entry.slice) {
    const insertPos = before ? $pos.before() : $pos.after();
    tr.insert(insertPos, entry.slice.content);
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1), 1));
  } else if (entry.type === "line") {
    const insertPos = before ? $pos.before() : $pos.after();
    const cleanLines = entry.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const nodesToInsert = cleanLines.map(
      (line) => state.schema.nodes.paragraph.create(null, line.length > 0 ? state.schema.text(line) : void 0)
    );
    tr.insert(insertPos, nodesToInsert);
    const targetPos = insertPos + 1;
    tr.setSelection(TextSelection.create(tr.doc, targetPos));
  } else {
    const insertPos = before ? state.selection.from : Math.min($pos.end(), state.selection.from + 1);
    if (entry.slice) tr.replaceRange(insertPos, insertPos, entry.slice);
    else tr.insertText(entry.text, insertPos);
    const endPos = (entry.slice ? tr.mapping.map(insertPos) : insertPos + entry.text.length) - 1;
    tr.setSelection(TextSelection.create(tr.doc, Math.max(insertPos, endPos)));
  }
  dispatch(tr);
  resetBuffer();
}
function openBelow(ctx) {
  const { state, dispatch, updateVimState, resetBuffer } = ctx;
  const $pos = state.selection.$from;
  const targetPos = $pos.after();
  const p = state.schema.nodes.paragraph.create();
  const tr = state.tr.insert(targetPos, p);
  tr.setSelection(TextSelection.create(tr.doc, targetPos + 1));
  dispatch(tr);
  updateVimState({ mode: "insert" });
  resetBuffer();
}
function openAbove(ctx) {
  const { state, dispatch, updateVimState, resetBuffer } = ctx;
  const $pos = state.selection.$from;
  const targetPos = $pos.before();
  const p = state.schema.nodes.paragraph.create();
  const tr = state.tr.insert(targetPos, p);
  tr.setSelection(TextSelection.create(tr.doc, targetPos + 1));
  dispatch(tr);
  updateVimState({ mode: "insert" });
  resetBuffer();
}
function enterInsert(ctx, variation) {
  const { state, dispatch, updateVimState, resetBuffer } = ctx;
  const $pos = state.selection.$from;
  let targetPos = state.selection.from;
  if (variation === "a") {
    if (targetPos < $pos.end()) {
      targetPos++;
    }
  } else if (variation === "I") {
    targetPos = moveToFirstNonWhitespace(state, targetPos);
  } else if (variation === "A") {
    targetPos = $pos.end();
  }
  const tr = state.tr.setSelection(TextSelection.create(state.doc, targetPos));
  dispatch(tr);
  updateVimState({ mode: "insert" });
  resetBuffer();
}
function exitToNormal(ctx) {
  const { state, dispatch, vimState, updateVimState, resetBuffer } = ctx;
  if (vimState.mode === "insert") {
    const $pos = state.selection.$from;
    let targetPos = state.selection.from;
    if ($pos.parent.isTextblock) {
      const textLen = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC").length;
      if (textLen > 0) {
        if ($pos.parentOffset >= textLen) {
          targetPos = $pos.start() + textLen - 1;
        } else if ($pos.parentOffset > 0) {
          targetPos = Math.max($pos.start(), targetPos - 1);
        }
      } else {
        targetPos = $pos.start();
      }
    }
    const tr = state.tr.setSelection(TextSelection.create(state.doc, targetPos));
    dispatch(tr);
  } else if (vimState.mode === "visual" || vimState.mode === "visual-line") {
    const targetPos = state.selection.from;
    const tr = state.tr.setSelection(TextSelection.create(state.doc, targetPos));
    dispatch(tr);
  } else {
    if (!state.selection.empty) {
      const tr = state.tr.setSelection(TextSelection.create(state.doc, state.selection.from));
      dispatch(tr);
    }
  }
  updateVimState({ mode: "normal", visualAnchor: null, visualHead: null });
  resetBuffer();
}
function replaceChar(ctx, char) {
  const { state, dispatch, resetBuffer } = ctx;
  const pos = state.selection.from;
  const $pos = state.doc.resolve(pos);
  if (pos >= $pos.end()) {
    resetBuffer();
    return;
  }
  const tr = state.tr.replaceWith(pos, pos + 1, state.schema.text(char));
  tr.setSelection(TextSelection.create(tr.doc, pos));
  dispatch(tr);
  resetBuffer();
}

// src/input/keyDispatcher.ts
function handleKeyDown(ctx, event) {
  const { vimState } = ctx;
  const { key, ctrlKey, metaKey, altKey } = event;
  if (metaKey || altKey) {
    return false;
  }
  if (vimState.mode === "insert") {
    if (key === "Escape" || ctrlKey && key === "[" || ctrlKey && key === "c") {
      event.preventDefault();
      exitToNormal(ctx);
      return true;
    }
    return false;
  }
  if (ctrlKey) {
    if (key.toLowerCase() === "r" && vimState.mode === "normal") {
      event.preventDefault();
      ctx.editor.commands.redo();
      return true;
    }
    if (key === "[") {
      event.preventDefault();
      exitToNormal(ctx);
      return true;
    }
    return false;
  }
  event.preventDefault();
  if (key === "Escape") {
    exitToNormal(ctx);
    return true;
  }
  const count = vimState.count ?? 1;
  if (vimState.pendingOperator === "r") {
    if (key.length === 1) {
      replaceChar(ctx, key);
    } else {
      ctx.resetBuffer();
    }
    return true;
  }
  if (vimState.pendingFind) {
    if (key.length === 1) {
      handleFindChar(ctx, vimState.pendingFind, key, count);
    } else {
      ctx.resetBuffer();
    }
    return true;
  }
  if (/^[0-9]$/.test(key)) {
    if (key === "0" && vimState.count === null && !vimState.pendingOperator) {
      executeMotion(ctx, (s, p) => moveToLineStart(s, p));
      return true;
    }
    const newCount = (vimState.count ?? 0) * 10 + parseInt(key, 10);
    ctx.updateVimState({
      count: newCount,
      keyBuffer: (vimState.keyBuffer || "") + key
    });
    return true;
  }
  if (key === ";" || key === ",") {
    if (vimState.lastFind) {
      let findType = vimState.lastFind.type;
      if (key === ",") {
        if (findType === "f") findType = "F";
        else if (findType === "F") findType = "f";
        else if (findType === "t") findType = "T";
        else if (findType === "T") findType = "t";
      }
      handleFindChar(ctx, findType, vimState.lastFind.char, count);
      return true;
    }
    ctx.resetBuffer();
    return true;
  }
  if (key === "f" || key === "F" || key === "t" || key === "T") {
    ctx.updateVimState({
      pendingFind: key,
      keyBuffer: (vimState.keyBuffer || "") + key
    });
    return true;
  }
  if (vimState.mode === "visual" || vimState.mode === "visual-line") {
    return handleVisualKey(ctx, key, count);
  }
  if (vimState.pendingOperator) {
    return handlePendingOperatorKey(ctx, key, count);
  }
  switch (key) {
    case "i":
      enterInsert(ctx, "i");
      return true;
    case "a":
      enterInsert(ctx, "a");
      return true;
    case "I":
      enterInsert(ctx, "I");
      return true;
    case "A":
      enterInsert(ctx, "A");
      return true;
    case "o":
      openBelow(ctx);
      return true;
    case "O":
      openAbove(ctx);
      return true;
    case "v":
      enterVisualMode(ctx, "visual");
      return true;
    case "V":
      enterVisualMode(ctx, "visual-line");
      return true;
  }
  switch (key) {
    case "x":
      deleteChar(ctx, count);
      return true;
    case "u":
      ctx.editor.commands.undo();
      ctx.resetBuffer();
      return true;
    case "p":
      put(ctx, false);
      return true;
    case "P":
      put(ctx, true);
      return true;
    case "D":
      deleteRange(ctx, ctx.state.selection.from, moveToLineEnd(ctx.state, ctx.state.selection.from, "visual"));
      return true;
    case "C":
      changeRange(ctx, ctx.state.selection.from, moveToLineEnd(ctx.state, ctx.state.selection.from, "visual"));
      return true;
    case "Y":
      yankLine(ctx, count);
      return true;
    case "s":
      changeRange(ctx, ctx.state.selection.from, ctx.state.selection.from + 1);
      return true;
    case "S":
      changeLine(ctx);
      return true;
  }
  if (key === "d" || key === "c" || key === "y" || key === "r") {
    ctx.updateVimState({
      pendingOperator: key,
      operatorCount: count,
      count: null,
      keyBuffer: (vimState.keyBuffer || "") + key
    });
    return true;
  }
  if (key === "g") {
    if (vimState.keyBuffer.endsWith("g")) {
      const targetPos = jumpToTop(ctx.state, vimState.count);
      setCursorPos(ctx, targetPos);
      ctx.resetBuffer();
    } else {
      ctx.updateVimState({
        keyBuffer: (vimState.keyBuffer || "") + "g"
      });
    }
    return true;
  }
  if (key === "G") {
    const targetPos = jumpToBottom(ctx.state, vimState.count);
    setCursorPos(ctx, targetPos);
    ctx.resetBuffer();
    return true;
  }
  return dispatchMotion(ctx, key, count);
}
function handleFindChar(ctx, findType, char, count) {
  const { state, vimState, updateVimState, resetBuffer } = ctx;
  const currentPos = vimState.mode === "visual" ? vimState.visualHead ?? state.selection.from : state.selection.from;
  const totalCount = (vimState.operatorCount ?? 1) * count;
  const targetPos = findCharInLine(state, currentPos, findType, char, totalCount);
  updateVimState({
    lastFind: { type: findType, char },
    pendingFind: null
  });
  if (targetPos === null) {
    resetBuffer();
    return;
  }
  if (vimState.pendingOperator) {
    const op = vimState.pendingOperator;
    const from = targetPos < currentPos ? targetPos : currentPos;
    const to = targetPos >= currentPos ? targetPos + 1 : currentPos + 1;
    if (op === "d") deleteRange(ctx, from, to);
    else if (op === "c") changeRange(ctx, from, to);
    else if (op === "y") yankRange(ctx, from, to);
    return;
  }
  if (vimState.mode === "visual" || vimState.mode === "visual-line") {
    applyMotionPosition(ctx, targetPos, null);
    resetBuffer();
    return;
  }
  setCursorPos(ctx, targetPos);
  resetBuffer();
}
function handlePendingOperatorKey(ctx, key, count) {
  const { vimState, state } = ctx;
  const op = vimState.pendingOperator;
  const totalCount = (vimState.operatorCount ?? 1) * count;
  const currentPos = state.selection.from;
  if (key === op) {
    if (op === "d") deleteLine(ctx, totalCount);
    else if (op === "c") changeLine(ctx);
    else if (op === "y") yankLine(ctx, totalCount);
    return true;
  }
  let targetPos = null;
  let lineWise = false;
  switch (key) {
    case "h":
      targetPos = moveLeft(state, currentPos, totalCount);
      break;
    case "l":
      targetPos = moveRight(state, currentPos, totalCount, "visual");
      break;
    case "w":
      targetPos = moveWordForward(state, currentPos, totalCount);
      break;
    case "b":
      targetPos = moveWordBackward(state, currentPos, totalCount);
      break;
    case "e":
      targetPos = moveWordEnd(state, currentPos, totalCount) + 1;
      break;
    case "W":
      targetPos = moveBigWordForward(state, currentPos, totalCount);
      break;
    case "B":
      targetPos = moveBigWordBackward(state, currentPos, totalCount);
      break;
    case "E":
      targetPos = moveBigWordEnd(state, currentPos, totalCount) + 1;
      break;
    case "0":
      targetPos = moveToLineStart(state, currentPos);
      break;
    case "^":
      targetPos = moveToFirstNonWhitespace(state, currentPos);
      break;
    case "$":
      targetPos = moveToLineEnd(state, currentPos, "visual");
      break;
    case "_":
      targetPos = moveToFirstNonWhitespace(state, currentPos);
      break;
    case "{":
      targetPos = moveParagraphUp(state, currentPos, totalCount);
      lineWise = true;
      break;
    case "}":
      targetPos = moveParagraphDown(state, currentPos, totalCount);
      lineWise = true;
      break;
    case "%": {
      const matchPos = matchBracket(state, currentPos);
      if (matchPos !== null) {
        targetPos = matchPos >= currentPos ? matchPos + 1 : matchPos;
      }
      break;
    }
    case "j": {
      const res = moveDown(ctx.view, state, currentPos, totalCount);
      targetPos = res.pos;
      lineWise = true;
      break;
    }
    case "k": {
      const res = moveUp(ctx.view, state, currentPos, totalCount);
      targetPos = res.pos;
      lineWise = true;
      break;
    }
    case "G":
      targetPos = jumpToBottom(state, null);
      lineWise = true;
      break;
  }
  if (targetPos !== null) {
    if (op === "d") {
      deleteRange(ctx, currentPos, targetPos, lineWise);
    } else if (op === "c") {
      changeRange(ctx, currentPos, targetPos);
    } else if (op === "y") {
      yankRange(ctx, currentPos, targetPos, lineWise);
    }
    return true;
  }
  ctx.resetBuffer();
  return true;
}
function handleVisualKey(ctx, key, count) {
  const { state } = ctx;
  const { from, to } = state.selection;
  if (key === "d" || key === "x") {
    deleteRange(ctx, from, to, ctx.vimState.mode === "visual-line");
    ctx.updateVimState({ mode: "normal", visualAnchor: null, visualHead: null });
    return true;
  }
  if (key === "c" || key === "s") {
    changeRange(ctx, from, to);
    ctx.updateVimState({ mode: "insert", visualAnchor: null, visualHead: null });
    return true;
  }
  if (key === "y") {
    yankRange(ctx, from, to, ctx.vimState.mode === "visual-line");
    ctx.updateVimState({ mode: "normal", visualAnchor: null, visualHead: null });
    return true;
  }
  if (key === "v") {
    if (ctx.vimState.mode === "visual") {
      exitToNormal(ctx);
    } else {
      enterVisualMode(ctx, "visual");
    }
    return true;
  }
  if (key === "V") {
    if (ctx.vimState.mode === "visual-line") {
      exitToNormal(ctx);
    } else {
      if (ctx.vimState.mode === "visual") {
        const anchor = ctx.vimState.visualAnchor ?? state.selection.anchor;
        const head = ctx.vimState.visualHead ?? state.selection.head;
        const $anchor = state.doc.resolve(anchor);
        const $head = state.doc.resolve(head);
        let tr;
        if ($head.start() >= $anchor.start()) {
          tr = state.tr.setSelection(TextSelection2.create(state.doc, $anchor.start(), $head.end()));
        } else {
          tr = state.tr.setSelection(TextSelection2.create(state.doc, $anchor.end(), $head.start()));
        }
        ctx.dispatch(tr);
        ctx.updateVimState({ mode: "visual-line" });
        ctx.resetBuffer();
      } else {
        enterVisualMode(ctx, "visual-line");
      }
    }
    return true;
  }
  return dispatchMotion(ctx, key, count);
}
function dispatchMotion(ctx, key, count) {
  const { state, view, vimState } = ctx;
  const isVisual = vimState.mode === "visual" || vimState.mode === "visual-line";
  const currentPos = isVisual ? vimState.visualHead ?? state.selection.from : state.selection.head ?? state.selection.from;
  let targetPos = null;
  let nextColumn = vimState.desiredColumn;
  switch (key) {
    case "h":
      targetPos = moveLeft(state, currentPos, count);
      nextColumn = null;
      break;
    case "l":
      targetPos = moveRight(state, currentPos, count, vimState.mode);
      nextColumn = null;
      break;
    case "0":
      targetPos = moveToLineStart(state, currentPos);
      nextColumn = null;
      break;
    case "^":
      targetPos = moveToFirstNonWhitespace(state, currentPos);
      nextColumn = null;
      break;
    case "$":
      targetPos = moveToLineEnd(state, currentPos, vimState.mode);
      nextColumn = null;
      break;
    case "w":
      targetPos = moveWordForward(state, currentPos, count);
      nextColumn = null;
      break;
    case "b":
      targetPos = moveWordBackward(state, currentPos, count);
      nextColumn = null;
      break;
    case "e":
      targetPos = moveWordEnd(state, currentPos, count);
      nextColumn = null;
      break;
    case "j": {
      if (vimState.mode === "visual-line") {
        targetPos = moveParagraphDown(state, currentPos, count);
        nextColumn = null;
      } else {
        const res = moveDown(view, state, currentPos, count, vimState.desiredColumn);
        targetPos = res.pos;
        nextColumn = res.column;
      }
      break;
    }
    case "k": {
      if (vimState.mode === "visual-line") {
        targetPos = moveParagraphUp(state, currentPos, count);
        nextColumn = null;
      } else {
        const res = moveUp(view, state, currentPos, count, vimState.desiredColumn);
        targetPos = res.pos;
        nextColumn = res.column;
      }
      break;
    }
    case "W":
      targetPos = moveBigWordForward(state, currentPos, count);
      nextColumn = null;
      break;
    case "B":
      targetPos = moveBigWordBackward(state, currentPos, count);
      nextColumn = null;
      break;
    case "E":
      targetPos = moveBigWordEnd(state, currentPos, count);
      nextColumn = null;
      break;
    case "{":
      targetPos = moveParagraphUp(state, currentPos, count);
      nextColumn = null;
      break;
    case "}":
      targetPos = moveParagraphDown(state, currentPos, count);
      nextColumn = null;
      break;
    case "%":
      targetPos = matchBracket(state, currentPos);
      nextColumn = null;
      break;
    case "_":
      targetPos = moveToFirstNonWhitespace(state, currentPos);
      nextColumn = null;
      break;
    default:
      ctx.resetBuffer();
      return false;
  }
  if (targetPos !== null) {
    applyMotionPosition(ctx, targetPos, nextColumn);
  }
  ctx.resetBuffer();
  return true;
}
function applyMotionPosition(ctx, targetPos, column) {
  const { state, dispatch, vimState, updateVimState } = ctx;
  if (vimState.mode === "visual") {
    const anchor = vimState.visualAnchor ?? state.selection.anchor;
    const $target = state.doc.resolve(targetPos);
    let tr;
    if (targetPos >= anchor) {
      const to = Math.min($target.end(), targetPos + 1);
      tr = state.tr.setSelection(TextSelection2.create(state.doc, anchor, to));
    } else {
      const anchor$pos = state.doc.resolve(anchor);
      const anchorTo = Math.min(anchor$pos.end(), anchor + 1);
      tr = state.tr.setSelection(TextSelection2.create(state.doc, anchorTo, targetPos));
    }
    dispatch(tr);
    updateVimState({ desiredColumn: column, visualHead: targetPos });
  } else if (vimState.mode === "visual-line") {
    const anchor = vimState.visualAnchor ?? state.selection.anchor;
    const $anchor = state.doc.resolve(anchor);
    const $target = state.doc.resolve(targetPos);
    let tr;
    if ($target.start() >= $anchor.start()) {
      tr = state.tr.setSelection(TextSelection2.create(state.doc, $anchor.start(), $target.end()));
    } else {
      tr = state.tr.setSelection(TextSelection2.create(state.doc, $anchor.end(), $target.start()));
    }
    dispatch(tr);
    updateVimState({ desiredColumn: column, visualHead: targetPos });
  } else {
    setCursorPos(ctx, targetPos);
    updateVimState({ desiredColumn: column, visualHead: null });
  }
}
function executeMotion(ctx, motionFn) {
  const currentPos = ctx.state.selection.from;
  const targetPos = motionFn(ctx.state, currentPos);
  setCursorPos(ctx, targetPos);
  ctx.resetBuffer();
}
function sanitizeNormalModePos(doc, pos) {
  const safePos = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(safePos);
  if ($pos.parent.isTextblock) {
    const textLen = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\uFFFC").length;
    if (textLen === 0) {
      return $pos.start();
    }
    const maxPos = $pos.start() + textLen - 1;
    return Math.min(Math.max($pos.start(), safePos), maxPos);
  }
  const sel = TextSelection2.near($pos);
  const $valid = sel.$from;
  if ($valid.parent.isTextblock) {
    const textLen = $valid.parent.textBetween(0, $valid.parent.content.size, "\n", "\uFFFC").length;
    if (textLen === 0) return $valid.start();
    return Math.min($valid.pos, $valid.start() + textLen - 1);
  }
  return sel.from;
}
function setCursorPos(ctx, pos) {
  const validPos = sanitizeNormalModePos(ctx.state.doc, pos);
  const tr = ctx.state.tr.setSelection(TextSelection2.create(ctx.state.doc, validPos));
  ctx.dispatch(tr);
}
function enterVisualMode(ctx, mode) {
  const pos = ctx.state.selection.from;
  const { state, dispatch, updateVimState, resetBuffer } = ctx;
  if (mode === "visual-line") {
    const $pos = state.doc.resolve(pos);
    const tr = state.tr.setSelection(TextSelection2.create(state.doc, $pos.start(), $pos.end()));
    dispatch(tr);
  } else {
    const $pos = state.doc.resolve(pos);
    const to = Math.min($pos.end(), pos + 1);
    const tr = state.tr.setSelection(TextSelection2.create(state.doc, pos, to));
    dispatch(tr);
  }
  updateVimState({ mode, visualAnchor: pos, visualHead: pos });
  resetBuffer();
}

// src/vimExtension.ts
var Vim = Extension.create({
  name: "vim",
  addOptions() {
    return {
      defaultMode: "normal"
    };
  },
  addStorage() {
    return {
      mode: this.options.defaultMode ?? "normal",
      keyBuffer: "",
      count: null,
      register: null
    };
  },
  addCommands() {
    return {
      setVimMode: (mode) => ({ editor, tr, dispatch }) => {
        if (dispatch) {
          editor.storage.vim.mode = mode;
          editor.view.dom.setAttribute("data-vim-mode", mode);
          tr.setMeta(vimPluginKey, { mode });
          dispatch(tr);
        }
        return true;
      }
    };
  },
  onCreate() {
    const defaultMode = this.options.defaultMode ?? "normal";
    this.storage.mode = defaultMode;
    if (this.editor.view && this.editor.view.dom) {
      this.editor.view.dom.setAttribute("data-vim-mode", defaultMode);
    }
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const vimStatePlugin = new Plugin2({
      key: vimPluginKey,
      state: {
        init: () => ({
          ...initialVimState,
          mode: this.options.defaultMode ?? "normal"
        }),
        apply: (tr, value) => {
          const meta = tr.getMeta(vimPluginKey);
          if (meta) {
            return { ...value, ...meta };
          }
          return value;
        }
      },
      props: {
        handleKeyDown: (view, event) => {
          const currentState = vimPluginKey.getState(view.state) ?? initialVimState;
          const updateVimState = (updates) => {
            const newState = { ...currentState, ...updates };
            const tr = view.state.tr.setMeta(vimPluginKey, updates);
            view.dispatch(tr);
            editor.storage.vim.mode = newState.mode;
            editor.storage.vim.keyBuffer = newState.keyBuffer;
            editor.storage.vim.count = newState.count;
            editor.storage.vim.register = registers.get();
            if (updates.mode) {
              view.dom.setAttribute("data-vim-mode", updates.mode);
            }
          };
          const resetBuffer = () => {
            updateVimState({
              keyBuffer: "",
              count: null,
              pendingOperator: null,
              operatorCount: null,
              pendingFind: null
            });
          };
          const ctx = {
            editor,
            view,
            state: view.state,
            dispatch: (tr) => view.dispatch(tr),
            vimState: currentState,
            updateVimState,
            resetBuffer
          };
          return handleKeyDown(ctx, event);
        },
        handleTextInput: (view) => {
          const currentState = vimPluginKey.getState(view.state);
          if (currentState && currentState.mode !== "insert") {
            return true;
          }
          return false;
        }
      }
    });
    return [vimStatePlugin, createCursorPlugin()];
  }
});

// src/index.ts
var index_default = Vim;
export {
  Vim,
  changeLine,
  changeRange,
  index_default as default,
  deleteChar,
  deleteLine,
  deleteRange,
  enterInsert,
  exitToNormal,
  findCharInLine,
  getAllTextBlocks,
  initialVimState,
  jumpToBottom,
  jumpToTop,
  matchBracket,
  moveBigWordBackward,
  moveBigWordEnd,
  moveBigWordForward,
  moveDown,
  moveLeft,
  moveParagraphDown,
  moveParagraphUp,
  moveRight,
  moveToFirstNonWhitespace,
  moveToLineEnd,
  moveToLineStart,
  moveUp,
  moveWordBackward,
  moveWordEnd,
  moveWordForward,
  openAbove,
  openBelow,
  put,
  registers,
  replaceChar,
  vimPluginKey,
  yankLine,
  yankRange
};
