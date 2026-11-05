<script lang="ts">
  import { Editor } from "@tiptap/core";
  import { Placeholder } from "@tiptap/extensions";
  import { untrack } from "svelte";
  import { proseCodeBlock } from "./code-block";
  import { MarkdownCodec, markdownSchema } from "./markdown";
  import { MoveBlock } from "./move-block";
  import { CodeSelection, MarkdownPaste, TrailingParagraph } from "./prose";
  import VimBar from "./VimBar.svelte";
  import VimMode, { OPERATORS } from "./VimMode.svelte";
  import { vimExtensions } from "./vim/index";
  import { vimPluginKey } from "./vim/vendor";

  /** Keep's editor over a Markdown text: no title, no pages. `onchange` hears what the user edits, nothing else. */
  let {
    value,
    vim = false,
    readonly = false,
    placeholder,
    onchange,
    class: className = "",
  }: {
    value: string;
    /** Vim mode; switching it rebuilds the editor, the text kept. */
    vim?: boolean;
    readonly?: boolean;
    placeholder?: string;
    onchange?: (markdown: string) => void;
    class?: string;
  } = $props();

  const codec = new MarkdownCodec();

  /** The text as it last came in or went out: a `value` equal to it is nothing new. */
  let known = untrack(() => value);
  /** What came in, and what the editor would write for it: an edit undone gives the text back as it was, to the byte. */
  let base = { raw: "", normal: "", before: "", after: "" };

  /** The document for a text, remembered as the base. A text the schema cannot hold is shown as it is, one paragraph. */
  function load(text: string) {
    known = text;
    const doc = codec.parse(text) ?? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
    const before = /^\s*/.exec(text)?.[0] ?? "";
    const after = text.trim() ? (/\s*$/.exec(text)?.[0] ?? "") : "";
    base = { raw: text, normal: codec.serialize(doc), before, after };
    return doc;
  }

  let host = $state<HTMLDivElement>();
  let editor = $state.raw<Editor | null>(null);
  let bar = $state<VimBar>();
  let barOpen = $state(false);
  /** Vim's mode while the editor has focus. */
  let mode = $state<string | null>(null);
  let focused = $state(false);
  let message = $state<{ text: string; kind: "info" | "error" } | null>(null);
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  function show(text: string, kind: "info" | "error") {
    clearTimeout(messageTimer);
    message = { text, kind };
    messageTimer = setTimeout(() => (message = null), 3000);
  }

  $effect(() => {
    if (!host) return;
    const instance = new Editor({
      element: host,
      extensions: [
        ...markdownSchema(proseCodeBlock()),
        Placeholder.configure({
          showOnlyCurrent: false,
          placeholder: ({ editor }) => (editor.isEmpty ? (untrack(() => placeholder) ?? "") : ""),
        }),
        MarkdownPaste.configure({ parse: (text) => codec.parse(text) }),
        CodeSelection,
        MoveBlock,
        TrailingParagraph,
        ...(vim
          ? vimExtensions({
              onPrompt: (kind, visual) => bar?.open(kind, visual),
              scrolloff: () => 4,
              lineNumbers: () => "off",
              numbersSide: () => "right",
            })
          : []),
      ],
      // Read untracked, or every keystroke would rebuild the editor.
      content: untrack(() => load(known)),
      editable: untrack(() => !readonly),
      editorProps: { attributes: { class: "desk-prose" } },
      onTransaction: ({ editor: e }) => {
        const state = vimPluginKey.getState(e.state);
        mode = state ? (OPERATORS[state.pendingOperator ?? ""] ?? state.mode) : null;
      },
      onFocus: () => (focused = true),
      onBlur: () => (focused = false),
      onUpdate: ({ editor: e }) => {
        if (!e.isEditable) return;
        const markdown = codec.serialize(e.getJSON());
        const next = markdown === base.normal ? base.raw : base.before + markdown + base.after;
        if (next === known) return;
        known = next;
        onchange?.(next);
      },
    });
    editor = instance;
    mode = vim ? "normal" : null;
    return () => {
      instance.destroy();
      editor = null;
    };
  });

  // A text from outside replaces what is shown, silently, and is not a step to undo.
  $effect(() => {
    const next = value;
    const instance = untrack(() => editor);
    if (!instance || next === known) return;
    instance.chain().setMeta("addToHistory", false).setContent(load(next), { emitUpdate: false }).run();
  });

  $effect(() => {
    const instance = editor;
    const next = !readonly;
    // Silent: an update emitted here would write the text back.
    untrack(() => instance?.setEditable(next, false));
  });

  $effect(() => () => clearTimeout(messageTimer));

  /** A link opens in a new tab: the text around it is the editor's to click into. */
  function onclick(event: MouseEvent) {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a.link");
    if (!link) return;
    event.preventDefault();
    if (link.href && editor?.state.selection.empty) window.open(link.href, "_blank", "noopener");
  }
</script>

<div class="desk-editor {className}">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions — a link is inside text the editor owns; Enter on it is the editor's. -->
  <div class="host" bind:this={host} {onclick}></div>
</div>
{#if vim}<VimBar bind:this={bar} bind:active={barOpen} {editor} onmessage={show} />{/if}
{#if (vim && mode && (focused || barOpen)) || message}
  <div class="status">
    {#if message}<span class="message" class:error={message.kind === "error"}>{message.text}</span>{/if}
    {#if vim && mode && (focused || barOpen)}<VimMode {mode} />{/if}
  </div>
{/if}

<style>
  .host {
    position: relative;
  }
  .status {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    pointer-events: none;
  }
  .message {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-45);
  }
  .message.error {
    color: var(--hot);
  }
</style>
