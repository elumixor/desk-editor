import { type Editor, Extension, type JSONContent } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Inline code paints its own background over the selection's; the code inside a selection is marked, so CSS can paint
 * it selected instead (`.in-selection`). Only code is decorated: splitting all text while a drag selects would
 * disturb the selection being made.
 */
export const CodeSelection = Extension.create({
  name: "codeSelection",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { from, to, empty } = state.selection;
            if (empty) return null;
            const found: Decoration[] = [];
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (node.isText && node.marks.some((m) => m.type.name === "code"))
                found.push(
                  Decoration.inline(Math.max(from, pos), Math.min(to, pos + node.nodeSize), { class: "in-selection" }),
                );
            });
            return DecorationSet.create(state.doc, found);
          },
        },
      }),
    ];
  },
});

/** The document always ends in an empty paragraph, to move down into after a table, a code block or any other last block. */
export const TrailingParagraph = Extension.create({
  name: "trailingParagraph",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        appendTransaction: (transactions, _old, state) => {
          if (!editor.isEditable || !transactions.some((t) => t.docChanged)) return null;
          const last = state.doc.lastChild;
          if (!last || (last.type.name === "paragraph" && last.childCount === 0)) return null;
          const paragraph = state.schema.nodes.paragraph;
          return paragraph ? state.tr.insert(state.doc.content.size, paragraph.create()) : null;
        },
      }),
    ];
  },
});

const MARKDOWN_HINT = /^(#{1,6} |[-*] |\d+\. |> |```|- \[[ x]\] )|\*\*|__|\[.+\]\(.+\)/m;

export interface MarkdownPasteOptions {
  /** Markdown as a document; by default the `Markdown` extension's parser. */
  parse?: (text: string, editor: Editor) => JSONContent | null | undefined;
  /** What a bare address pasted alone becomes, if anything but a link (a mention, say). */
  address?: (text: string) => JSONContent | null;
  /** The parsed document before it goes in. */
  transform?: (doc: JSONContent) => JSONContent;
}

/** Plain text that looks like Markdown is pasted as the blocks it describes, not as one paragraph of symbols. */
export const MarkdownPaste = Extension.create<MarkdownPasteOptions>({
  name: "markdownPaste",
  addOptions() {
    return {};
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { parse, address, transform } = this.options;
    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const data = event.clipboardData;
            const text = data?.getData("text/plain");
            if (!text || data?.getData("text/html")) return false;
            const single = address?.(text.trim());
            if (single) return editor.commands.insertContent(single);
            if (!MARKDOWN_HINT.test(text)) return false;
            const parsed = parse ? parse(text, editor) : editor.markdown?.parse(text);
            if (!parsed) return false;
            return editor.commands.insertContent((transform ? transform(parsed) : parsed).content ?? []);
          },
        },
      }),
    ];
  },
});
