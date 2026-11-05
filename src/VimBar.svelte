<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { flushSync } from "svelte";
  import { runCommand, substitutePattern } from "./vim/command";
  import type { PromptKind } from "./vim/keys";
  import { highlight, isShown, jump, lastPattern } from "./vim/search";

  /**
   * The bar `/`, `?` and `:` open under an editor. `active`: it is open. `onmessage`: what a command has to say, or that
   * it could not.
   */
  let {
    editor,
    active = $bindable(false),
    onmessage,
  }: {
    editor: Editor | null;
    active?: boolean;
    onmessage?: (message: string, kind: "info" | "error") => void;
  } = $props();

  /**
   * Where the cursor was (a search runs on from there), the lines of the visual selection `:` was pressed in, and the
   * search shown before, which Escape puts back.
   */
  let prompt = $state<{
    kind: PromptKind;
    text: string;
    from: number;
    visual: [number, number] | null;
    before: { pattern: string; shown: boolean };
  } | null>(null);
  let input = $state<HTMLInputElement>();

  /** Drawn and focused before the key handler returns, so the keys typed right after `/` land in the bar. */
  export function open(kind: PromptKind, visual: [number, number] | null) {
    if (!editor) return;
    const before = { pattern: lastPattern(editor.view), shown: isShown(editor.view) };
    const text = visual ? "'<,'>" : "";
    flushSync(() => {
      prompt = { kind, text, from: editor?.state.selection.from ?? 0, visual, before };
      active = true;
    });
    input?.focus();
  }

  function close() {
    prompt = null;
    active = false;
  }

  /** As the bar is typed into, the page shows what the search (or the `:s` pattern) matches. */
  function preview() {
    if (!editor || !prompt) return;
    const pattern = prompt.kind === ":" ? substitutePattern(editor.view, prompt.text) : prompt.text;
    highlight(editor.view, pattern ? { pattern } : prompt.before);
  }

  function onkeydown(event: KeyboardEvent) {
    if (!editor || !prompt) return;
    const { view } = editor;
    if (event.key === "Enter") {
      if (prompt.kind === ":") {
        const outcome = runCommand(view, prompt.text, prompt.visual);
        if (outcome.error) {
          highlight(view, prompt.before);
          onmessage?.(outcome.error, "error");
        } else if (outcome.message) onmessage?.(outcome.message, "info");
      } else {
        const pattern = prompt.text || prompt.before.pattern;
        highlight(view, { pattern, reverse: prompt.kind === "?" });
        if (pattern && !jump(view, 1, prompt.from)) onmessage?.(`Pattern not found: ${pattern}`, "error");
      }
    } else if (event.key === "Escape" || (event.key === "Backspace" && !prompt.text)) highlight(view, prompt.before);
    else return;
    event.preventDefault();
    close();
    view.focus();
  }
</script>

{#if prompt}
  <div class="bar">
    <span class="kind">{prompt.kind}</span>
    <input
      bind:this={input}
      class:mono={prompt.kind === ":"}
      aria-label={prompt.kind === ":" ? "Command" : "Search this page"}
      bind:value={prompt.text}
      oninput={preview}
      {onkeydown}
      onblur={close}
    />
  </div>
{/if}

<style>
  .bar {
    position: fixed;
    inset-inline: 0;
    bottom: 1rem;
    z-index: 30;
    margin-inline: auto;
    display: flex;
    width: 100%;
    max-width: 28rem;
    align-items: center;
    gap: 0.25rem;
    border-radius: var(--r);
    background: var(--surface);
    padding-inline: 0.75rem;
    box-shadow: var(--float-shadow);
  }
  .kind {
    font-family: var(--mono);
    color: var(--ink-45);
  }
  input {
    height: 2.25rem;
    min-width: 0;
    flex: 1;
    border: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    caret-color: var(--accent);
    outline: none;
  }
  input.mono {
    font-family: var(--mono);
  }
</style>
