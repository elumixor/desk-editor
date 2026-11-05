import { Editor, Extension } from '@tiptap/core';
import { EditorView } from '@tiptap/pm/view';
import { EditorState, Transaction, PluginKey } from '@tiptap/pm/state';
import { Node } from '@tiptap/pm/model';

type VimMode = 'normal' | 'insert' | 'visual' | 'visual-line';
type RegisterType = 'char' | 'line';
interface RegisterEntry {
    text: string;
    type: RegisterType;
    /** The yanked document content, mentions and marks as they were. */
    slice?: import("prosemirror-model").Slice;
}
interface VimState {
    mode: VimMode;
    keyBuffer: string;
    count: number | null;
    pendingOperator: string | null;
    operatorCount: number | null;
    visualAnchor: number | null;
    visualHead: number | null;
    desiredColumn: number | null;
    pendingFind: 'f' | 'F' | 't' | 'T' | null;
    lastFind: {
        type: 'f' | 'F' | 't' | 'T';
        char: string;
    } | null;
}
interface CommandContext {
    editor: Editor;
    view: EditorView;
    state: EditorState;
    dispatch: (tr: Transaction) => void;
    vimState: VimState;
    updateVimState: (updates: Partial<VimState>) => void;
    resetBuffer: () => void;
}
interface MotionRange {
    from: number;
    to: number;
    lineWise?: boolean;
}
interface VimExtensionStorage {
    mode: VimMode;
    keyBuffer: string;
    count: number | null;
    register: RegisterEntry | null;
}

interface VimOptions {
    defaultMode?: VimMode;
}
declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        vim: {
            /**
             * Set the active Vim mode
             */
            setVimMode: (mode: VimMode) => ReturnType;
        };
    }
}
declare const Vim: Extension<VimOptions, VimExtensionStorage>;

declare const vimPluginKey: PluginKey<VimState>;
declare const initialVimState: VimState;

declare class RegisterManager {
    private defaultRegister;
    set(entry: RegisterEntry): void;
    get(): RegisterEntry | null;
}
declare const registers: RegisterManager;

/**
 * Move left within the current block
 */
declare function moveLeft(state: EditorState, pos: number, count?: number): number;
/**
 * Move right within the current block
 */
declare function moveRight(state: EditorState, pos: number, count?: number, mode?: VimMode): number;
/**
 * Move to start of current block (0)
 */
declare function moveToLineStart(state: EditorState, pos: number): number;
/**
 * Move to first non-whitespace character in block (^)
 */
declare function moveToFirstNonWhitespace(state: EditorState, pos: number): number;
/**
 * Move to end of current block ($)
 */
declare function moveToLineEnd(state: EditorState, pos: number, mode?: VimMode): number;
/**
 * Find character on current line (f, F, t, T)
 */
declare function findCharInLine(state: EditorState, pos: number, type: 'f' | 'F' | 't' | 'T', char: string, count?: number): number | null;
/**
 * Jump to matching bracket/parenthesis (%)
 */
declare function matchBracket(state: EditorState, pos: number): number | null;

/**
 * Move forward to start of next word (w)
 */
declare function moveWordForward(state: EditorState, pos: number, count?: number): number;
/**
 * Move backward to start of previous word (b)
 */
declare function moveWordBackward(state: EditorState, pos: number, count?: number): number;
/**
 * Move forward to end of current/next word (e)
 */
declare function moveWordEnd(state: EditorState, pos: number, count?: number): number;
/**
 * Move forward to start of next WORD (W) - whitespace delimited
 */
declare function moveBigWordForward(state: EditorState, pos: number, count?: number): number;
/**
 * Move backward to start of previous WORD (B) - whitespace delimited
 */
declare function moveBigWordBackward(state: EditorState, pos: number, count?: number): number;
/**
 * Move forward to end of current/next WORD (E) - whitespace delimited
 */
declare function moveBigWordEnd(state: EditorState, pos: number, count?: number): number;

interface TextBlockInfo {
    start: number;
    end: number;
    node: Node;
}
/**
 * Helper to collect all textblocks in document with their start and end positions
 */
declare function getAllTextBlocks(doc: Node): TextBlockInfo[];
/**
 * Move vertically down (j)
 */
declare function moveDown(view: EditorView, state: EditorState, pos: number, count?: number, desiredColumn?: number | null): {
    pos: number;
    column: number;
};
/**
 * Move vertically up (k)
 */
declare function moveUp(view: EditorView, state: EditorState, pos: number, count?: number, desiredColumn?: number | null): {
    pos: number;
    column: number;
};
/**
 * Jump to top of document (gg) or specified line
 */
declare function jumpToTop(state: EditorState, lineNumber?: number | null): number;
/**
 * Jump to bottom of document (G) or specified line
 */
declare function jumpToBottom(state: EditorState, lineNumber?: number | null): number;
/**
 * Jump to next paragraph / block boundary (})
 */
declare function moveParagraphDown(state: EditorState, pos: number, count?: number): number;
/**
 * Jump to previous paragraph / block boundary ({)
 */
declare function moveParagraphUp(state: EditorState, pos: number, count?: number): number;

/**
 * Delete character under cursor (x)
 */
declare function deleteChar(ctx: CommandContext, count?: number): void;
/**
 * Delete current line/block (dd)
 */
declare function deleteLine(ctx: CommandContext, count?: number): void;
/**
 * Delete motion range (d{motion})
 */
declare function deleteRange(ctx: CommandContext, from: number, to: number, lineWise?: boolean): void;
/**
 * Change current line/block (cc)
 */
declare function changeLine(ctx: CommandContext): void;
/**
 * Change motion range (c{motion})
 */
declare function changeRange(ctx: CommandContext, from: number, to: number): void;
/**
 * Yank line (yy)
 */
declare function yankLine(ctx: CommandContext, count?: number): void;
/**
 * Yank motion range (y{motion})
 */
declare function yankRange(ctx: CommandContext, from: number, to: number, lineWise?: boolean): void;
/**
 * Put / Paste after (p) or before (P)
 */
declare function put(ctx: CommandContext, before?: boolean): void;
/**
 * Open new line below (o) and enter insert mode
 */
declare function openBelow(ctx: CommandContext): void;
/**
 * Open new line above (O) and enter insert mode
 */
declare function openAbove(ctx: CommandContext): void;
/**
 * Enter insert mode variations
 */
declare function enterInsert(ctx: CommandContext, variation: 'i' | 'a' | 'I' | 'A'): void;
/**
 * Exit to normal mode (<Esc>)
 */
declare function exitToNormal(ctx: CommandContext): void;
/**
 * Replace single character (r<char>)
 */
declare function replaceChar(ctx: CommandContext, char: string): void;

export { type CommandContext, type MotionRange, type RegisterEntry, type RegisterType, type TextBlockInfo, Vim, type VimExtensionStorage, type VimMode, type VimOptions, type VimState, changeLine, changeRange, Vim as default, deleteChar, deleteLine, deleteRange, enterInsert, exitToNormal, findCharInLine, getAllTextBlocks, initialVimState, jumpToBottom, jumpToTop, matchBracket, moveBigWordBackward, moveBigWordEnd, moveBigWordForward, moveDown, moveLeft, moveParagraphDown, moveParagraphUp, moveRight, moveToFirstNonWhitespace, moveToLineEnd, moveToLineStart, moveUp, moveWordBackward, moveWordEnd, moveWordForward, openAbove, openBelow, put, registers, replaceChar, vimPluginKey, yankLine, yankRange };
