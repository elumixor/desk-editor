# @desk/editor

Keep's TipTap editor and Vim layer, consumed as source via `github:elumixor/desk-editor` pinned by commit; never published to npm. Nothing here knows pages or an app's stores: what an app adds comes in as options (`leader`, `jumps`, `renderDiagram`, `MarkdownPaste`'s hooks).

- `vendor/tiptap-extension-vim` is the patched package: Bun applies `patchedDependencies` only from the installing root. Fix it there, always through `src/vim/vendor.ts`, so every consumer shares one `vimPluginKey`.
- Components use scoped styles on `@desk/core`'s tokens; prose and Vim CSS is `src/editor.css`. No Tailwind classes: Tailwind skips node_modules.
- `@tiptap/*` stay pinned to one exact version: `markdown.ts` replaces private methods of `MarkdownManager`.
