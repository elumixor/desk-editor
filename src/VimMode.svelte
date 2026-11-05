<script lang="ts" module>
  /** An operator waiting for its motion names the mode it puts the editor in. */
  export const OPERATORS: Readonly<Record<string, string>> = { d: "delete", c: "change", y: "yank" };
</script>

<script lang="ts">
  /** Vim's mode (`normal`, `visual-line`, an operator's), as an editor shows it while it has focus. */
  let { mode, class: className = "", style }: { mode: string; class?: string; style?: string } = $props();
</script>

<div class="desk-vim-mode {className}" {style} data-testid="vim-mode">
  {mode.replace("-", " ")}
</div>

<style>
  .desk-vim-mode {
    pointer-events: none;
    border-radius: var(--r-xs);
    background: var(--ink-5);
    padding: 0.125rem 0.375rem;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.025em;
    color: var(--ink-45);
    text-transform: uppercase;
  }
</style>
