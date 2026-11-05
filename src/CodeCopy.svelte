<script lang="ts">
  const COPIED_MS = 1500;

  /** Copies a code block's text; the icon turns into a check for a moment. */
  let { text }: { text: () => string } = $props();

  let copied = $state(false);

  async function copy() {
    await navigator.clipboard.writeText(text());
    copied = true;
    setTimeout(() => (copied = false), COPIED_MS);
  }
</script>

<button
  type="button"
  class="keep-code-copy"
  data-testid="code-copy"
  aria-label="Copy code"
  onmousedown={(event) => event.preventDefault()}
  onclick={copy}
>
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if copied}<path d="M20 6 9 17l-5-5" />{:else}<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />{/if}
  </svg>
</button>
