import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import type { Node as PmNode } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";
import { mount, unmount } from "svelte";
import CodeCopy from "./CodeCopy.svelte";

const MERMAID_LANGUAGE = "mermaid";
const RENDER_DELAY_MS = 250;

/** highlight.js's common languages; a diagram's source stays plain rather than guessed at. */
const lowlight = createLowlight(common);

/** A language drawn rather than highlighted: its source as SVG/HTML, throwing with a message where it cannot be read. */
export type Diagram = { label: string; render: (source: string) => Promise<string> | string };

/**
 * Code blocks, highlighted in the palette's colours (`.hljs-*` in `editor.css`). Given `diagrams` (by language) or
 * `renderDiagram` (Mermaid), a block in one of those languages is a diagram: edited as code with the drawing live
 * underneath, and shown as the drawing alone when the page is read (the source hides with CSS once the editor is not
 * editable). Without it, it is code like any other, so Mermaid is only in the bundles that ask for it.
 */
export const proseCodeBlock = ({
  renderDiagram,
  diagrams: extra = {},
}: { renderDiagram?: (source: string) => Promise<string>; diagrams?: Record<string, Diagram> } = {}) => {
  const diagrams: Record<string, Diagram> = { ...extra };
  if (renderDiagram) diagrams[MERMAID_LANGUAGE] ??= { label: "Mermaid", render: renderDiagram };
  for (const language of Object.keys(diagrams))
    if (!lowlight.registered(language)) lowlight.register(language, () => ({ name: language, contains: [] }));
  return CodeBlockLowlight.extend({
    addNodeView() {
      return ({ node }) => {
        const language = node.attrs.language as string | null;
        const diagram = language ? diagrams[language] : undefined;
        if (!diagram) {
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          if (language) code.className = `language-${language}`;
          pre.append(code);
          const dom = document.createElement("div");
          dom.className = "keep-code";
          const copy = document.createElement("span");
          copy.contentEditable = "false";
          const button = mount(CodeCopy, { target: copy, props: { text: () => code.textContent ?? "" } });
          dom.append(pre, copy);
          return {
            dom,
            contentDOM: code,
            update: (updated: PmNode) => updated.type === node.type && updated.attrs.language === language,
            ignoreMutation: (mutation) => mutation.type !== "selection" && !code.contains(mutation.target),
            destroy: () => void unmount(button),
          };
        }

        const dom = document.createElement("div");
        dom.className = "keep-diagram";
        dom.dataset.diagram = "";
        dom.dataset.language = language ?? "";
        const source = document.createElement("pre");
        source.className = "keep-diagram-source";
        const label = document.createElement("span");
        label.className = "keep-diagram-label";
        label.contentEditable = "false";
        label.textContent = diagram.label;
        const code = document.createElement("code");
        code.className = `language-${language}`;
        source.append(label, code);
        const preview = document.createElement("div");
        preview.className = "keep-diagram-preview";
        preview.contentEditable = "false";
        preview.dataset.testid = "diagram";
        dom.append(source, preview);

        let shown = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const draw = (text: string) => {
          if (text === shown) return;
          const first = !shown;
          shown = text;
          clearTimeout(timer);
          timer = setTimeout(
            async () => {
              if (!text.trim()) {
                preview.replaceChildren();
                preview.dataset.state = "empty";
                return;
              }
              try {
                const svg = await diagram.render(text);
                if (shown !== text) return;
                preview.innerHTML = svg;
                preview.dataset.state = "drawn";
              } catch (error) {
                if (shown !== text) return;
                const message = document.createElement("p");
                message.className = "keep-diagram-error";
                message.textContent = error instanceof Error ? error.message.split("\n")[0] : String(error);
                preview.replaceChildren(message);
                preview.dataset.state = "error";
              }
            },
            first ? 0 : RENDER_DELAY_MS,
          );
        };
        draw(node.textContent);

        return {
          dom,
          contentDOM: code,
          update: (updated: PmNode) => {
            if (updated.type !== node.type || updated.attrs.language !== language) return false;
            draw(updated.textContent);
            return true;
          },
          // The drawing changes on its own; ProseMirror must not take that for an edit.
          ignoreMutation: (mutation) => mutation.type !== "selection" && !code.contains(mutation.target),
          destroy: () => clearTimeout(timer),
        };
      };
    },
  }).configure({ lowlight });
};
