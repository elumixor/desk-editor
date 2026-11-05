import {
  type AnyExtension,
  getSchema,
  type JSONContent,
  type MarkdownRendererHelpers,
  type MarkdownToken,
  Node,
  renderNestedMarkdownContent,
} from "@tiptap/core";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Marked } from "marked";

/** What the manager keeps private but this file replaces: its escaping and what it does with HTML. */
interface Internals {
  encodeTextForMarkdown(text: string, node: JSONContent, parent?: JSONContent): string;
  parseHTMLToken(token: MarkdownToken): JSONContent | JSONContent[] | null;
  parseInlineTokens(tokens: MarkdownToken[]): JSONContent[];
  createLexer(): { inlineTokens(src: string): MarkdownToken[]; blockTokens(src: string): MarkdownToken[] };
}

const RAW_HTML = "rawHtml";

/**
 * An HTML block as Markdown has it: opaque lines up to the next blank one, kept as they are and edited as code. Prompts
 * and instructions write `<tags>` that mean nothing to a browser; turning them into DOM would lose them.
 */
export const RawHtml = Node.create({
  name: RAW_HTML,
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  renderHTML: () => ["pre", { class: "desk-raw-html" }, 0],
  parseHTML: () => [{ tag: "pre.desk-raw-html", preserveWhitespace: "full" }],
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? []),
});

/** `-` under a list keeps its soft-wrapped lines under the item, not flush with the margin. */
const SoftListItem = ListItem.extend({
  // Text after a nested block (a code fence, say) is a text token the stock parser would not read: a paragraph.
  parseMarkdown(token, helpers) {
    const tokens = token.tokens ?? [];
    const late = tokens.slice(1).some((t) => t.type === "text");
    const next = late
      ? { ...token, tokens: tokens.map((t) => (t.type === "text" ? { ...t, type: "paragraph" } : t)) }
      : token;
    return this.parent?.(next, helpers) ?? [];
  },
  renderMarkdown(node, h, ctx) {
    const ordered = ctx.parentType === "orderedList";
    const start = Number(ctx.meta?.parentAttrs?.start ?? 1);
    const prefix = ordered ? `${start + ctx.index}. ` : "- ";
    const under = " ".repeat(prefix.length);
    const main = {
      ...h,
      renderChildren: (nodes: JSONContent | JSONContent[], separator?: string) =>
        h.renderChildren(nodes, separator).replace(/\n(?=.)/g, `\n${under}`),
    };
    return renderNestedMarkdownContent(node, main, prefix, ctx, { alignNestedToPrefix: ordered }).replace(
      /^[ \t]+$/gm,
      "",
    );
  },
});

/** What makes a line more than text at the start of a paragraph. */
const BLOCK_START =
  /^( {0,3})(#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|<|`{3,}|~{3,}|=+[ \t]*$|-{3,}[ \t]*$|\*{3,}[ \t]*$|_{3,}[ \t]*$)/gm;

/** Its own marked, so the tokenizers extensions add stay away from the one a page editor's `Markdown` uses. */
const marked = new Marked({ gfm: true });

/** A paragraph's text that would read as another block gets a backslash where it starts; any other stays as it is. */
const TextParagraph = Paragraph.extend({
  // The stock parser lifts an image alone on its line out of the paragraph; here images are inline, as Markdown's are.
  parseMarkdown: (token, helpers) => {
    const content = helpers.parseInline(token.tokens ?? []);
    return helpers.createNode("paragraph", undefined, content);
  },
  renderMarkdown(node, h, ctx) {
    const text = this.parent?.(node, h, ctx) ?? "";
    if (!text.trim()) return text;
    const [first, ...rest] = marked.lexer(text);
    return first?.type === "paragraph" && !rest.some((t) => t.type !== "space")
      ? text
      : text.replace(BLOCK_START, (_all, space: string, mark: string) =>
          /^\d/.test(mark) ? `${space}${mark.replace(/[.)]/, "\\$&")}` : `${space}\\${mark}`,
        );
  },
});

/** A bare address, which Markdown makes a link by itself, stays bare. */
const bareLink = (text: string, href: string) =>
  text === href || href === `http://${text}` || href === `mailto:${text}`;

const renderTable = (node: JSONContent, h: MarkdownRendererHelpers) => {
  const rows = node.content ?? [];
  const cell = (c: JSONContent) =>
    h.renderChildren(c.content?.flatMap((p) => p.content ?? []) ?? []).replace(/\|/g, "\\|");
  const line = (row: JSONContent) => `| ${(row.content ?? []).map(cell).join(" | ")} |`;
  const [head, ...body] = rows;
  if (!head) return "";
  const rule = (head.content ?? []).map((c) => {
    const align = c.attrs?.align as string | undefined;
    return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
  });
  return [line(head), `| ${rule.join(" | ")} |`, ...body.map(line)].join("\n");
};

/**
 * The schema of a Markdown file: everything prose has, nothing about pages. `codeBlock` is what draws code in an editor
 * (`proseCodeBlock`); `roundTrip` has no use for drawing.
 */
export function markdownSchema(codeBlock: AnyExtension = CodeBlock): AnyExtension[] {
  return [
    StarterKit.configure({
      paragraph: false,
      link: false,
      underline: false,
      codeBlock: false,
      listItem: false,
      orderedList: false,
      trailingNode: false,
      code: false,
    }),
    TextParagraph,
    // Bold around code is common in Markdown; the stock mark refuses to share its text.
    Code.extend({ excludes: "" }),
    SoftListItem,
    // marked's own lists: the stock tokenizer outdents what is nested by two columns where the marker takes three.
    OrderedList.extend({
      markdownTokenizer: null as never,
      parseMarkdown(token, helpers) {
        if (token.type !== "list" || !token.ordered) return [];
        const start = Number(token.start || 1);
        return helpers.createNode(
          "orderedList",
          start === 1 ? undefined : { start },
          helpers.parseChildren(token.items ?? []),
        );
      },
    }),
    (codeBlock as typeof CodeBlock).extend({
      renderMarkdown(node, h) {
        const text = h.renderChildren(node.content ?? []);
        const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length));
        const fence = "`".repeat(longest + 1);
        return [`${fence}${node.attrs?.language ?? ""}`, text, fence].join("\n");
      },
    }),
    Link.extend({
      addAttributes() {
        return { ...this.parent?.() };
      },
      renderMarkdown(node, h, ctx) {
        const href = String(node.attrs?.href ?? "");
        const title = node.attrs?.title;
        const text = h.renderChildren(node);
        if (typeof ctx.meta?.markText === "string" && bareLink(ctx.meta.markText, href)) return text;
        return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
      },
    }).configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: "link" } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: true }),
    Table.extend({ renderMarkdown: renderTable }).configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    RawHtml,
  ];
}

/** The characters that can start inline syntax, the ones least likely to be wanted as such first. */
const INLINE_SYNTAX = ["\\", "`", "*", "_", "~", "[", "]", "<", "&", "!"];

export class MarkdownCodec {
  readonly #manager: MarkdownManager;
  readonly #inner: Internals;
  readonly #schema: ReturnType<typeof getSchema>;

  constructor(extensions: AnyExtension[] = markdownSchema()) {
    this.#manager = new MarkdownManager({ marked: marked as never, extensions });
    this.#schema = getSchema(extensions);
    this.#inner = this.#manager as unknown as Internals;
    this.#inner.parseHTMLToken = (token) => this.#html(token);
    this.#inner.encodeTextForMarkdown = (text, node, parent) => this.#encode(text, node, parent);
  }

  #html(token: MarkdownToken) {
    const html = String(token.raw ?? token.text ?? "");
    if (!token.block) return html ? { type: "text", text: html } : null;
    const text = html.replace(/\s+$/, "");
    return text ? { type: RAW_HTML, content: [{ type: "text", text }] } : null;
  }

  /** Whether this text, written as is, reads back as itself and nothing else. */
  #literal(written: string, text: string) {
    const nodes = this.#inner.parseInlineTokens(this.#inner.createLexer().inlineTokens(written));
    return nodes.length === 1 && nodes[0]?.type === "text" && !nodes[0].marks?.length && nodes[0].text === text;
  }

  /** The text with as few backslashes as it takes to stay text: none where nothing in it would be read as syntax. */
  #encode(text: string, node: JSONContent, parent?: JSONContent) {
    const code = (type?: string) =>
      !!type && (this.#schema.nodes[type]?.spec.code || this.#schema.marks[type]?.spec.code);
    if (code(parent?.type) || node.marks?.some((m) => code(m.type))) return text;
    if (!text.trim() || this.#literal(text, text)) return text;
    let written = text;
    for (const char of INLINE_SYNTAX) {
      if (!written.includes(char)) continue;
      written =
        char === "&"
          ? written.replace(/&(?=#?\w+;)/g, "&amp;")
          : written.replace(new RegExp(`(?<!\\\\)${char.replace(/[\\[\]*]/g, "\\$&")}`, "g"), `\\${char}`);
      if (this.#literal(written, text)) return written;
    }
    return written;
  }

  /** A soft-wrapped line's indent is the source's layout, not its text. */
  #tidy(node: JSONContent): JSONContent {
    if (node.text && !node.marks?.some((m) => m.type === "code"))
      return { ...node, text: node.text.replace(/\n[ \t]+/g, "\n") };
    if (!node.content || (node.type && this.#schema.nodes[node.type]?.spec.code)) return node;
    return { ...node, content: node.content.map((child) => this.#tidy(child)) };
  }

  /** Markdown as the document the editor holds; null when the schema cannot hold it. */
  parse(markdown: string): JSONContent | null {
    const doc = this.#manager.parse(markdown.replace(/\r\n?/g, "\n").trim());
    try {
      const node = this.#schema.nodeFromJSON(
        doc.content?.length ? this.#tidy(doc) : { type: "doc", content: [{ type: "paragraph" }] },
      );
      node.check();
      return node.toJSON();
    } catch {
      return null;
    }
  }

  /** The document as Markdown, without the empty lines the editor keeps at its end. */
  serialize(doc: JSONContent) {
    const content = [...(doc.content ?? [])];
    while (content.at(-1)?.type === "paragraph" && !content.at(-1)?.content?.length) content.pop();
    return this.#manager.serialize({ ...doc, content }).trim();
  }
}

let shared: MarkdownCodec | null = null;
const codec = () => {
  shared ??= new MarkdownCodec();
  return shared;
};

const edges = (markdown: string) => ({
  before: /^\s*/.exec(markdown)?.[0] ?? "",
  after: /\s*$/.exec(markdown)?.[0] ?? "",
});

/**
 * The text parsed and written back with the schema `MarkdownEditor` edits with, whitespace at its edges kept: what
 * would become of a file opened there. A text the schema cannot hold comes back empty.
 */
export function roundTrip(markdown: string) {
  if (!markdown.trim()) return markdown;
  const doc = codec().parse(markdown);
  if (!doc) return "";
  const { before, after } = edges(markdown);
  return before + codec().serialize(doc) + after;
}
