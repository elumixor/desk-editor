import { type JumpList, type Leader, VimKeys, type VimPrompt } from "./keys";
import type { LineNumbers } from "./lines";
import { Vim } from "./vendor";

/** Vim without its decoration cursor: `cursor.ts` draws one that blinks and moves smoothly. */
export const ModalVim = Vim.extend({
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).filter(
      (plugin) => !(plugin as unknown as { key: string }).key.startsWith("vim-cursor-plugin"),
    );
  },
});

export interface VimOptions {
  /** Opens the bar `/`, `?` and `:` type into (`VimBar`'s `open`). */
  onPrompt: VimPrompt;
  /** Lines kept around the cursor. */
  scrolloff: () => number;
  lineNumbers: () => LineNumbers;
  numbersSide: () => "left" | "right";
  /** What `space <key>` does; without it, space is Vim's. */
  leader?: Leader;
  /** Ctrl-O / Ctrl-I, across whatever the app keeps; without it, Vim's. */
  jumps?: JumpList;
}

/** Vim mode, starting in normal mode, and what the editor adds to it (`keys.ts`). */
export const vimExtensions = (options: VimOptions) => [
  ModalVim.configure({ defaultMode: "normal" }),
  VimKeys.configure(options),
];
