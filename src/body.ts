import type { Node } from "@tiptap/pm/model";

/**
 * Where a document's body starts among its top-level blocks: a page keeps its title first (a node named `title`),
 * which stays where it is and is not one of the body's lines; a plain document is all body.
 */
export const bodyStart = (doc: Node) => (doc.firstChild?.type.name === "title" ? 1 : 0);
