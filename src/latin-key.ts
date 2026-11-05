const PUNCTUATION: Record<string, [string, string]> = {
  Backquote: ["`", "~"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
};

/** The key a US layout would give: Vim keys keep working when the layout is Russian, Ukrainian, ... */
export function latinKey(event: KeyboardEvent): string {
  if (event.key.length !== 1 || event.key.charCodeAt(0) < 128) return event.key;
  const { code, shiftKey } = event;
  if (/^Key[A-Z]$/.test(code)) return shiftKey ? code[3] : code[3].toLowerCase();
  const punctuation = PUNCTUATION[code];
  return punctuation ? punctuation[shiftKey ? 1 : 0] : event.key;
}

/** Makes `event.key` the Latin key, for handlers that read it. */
export function latinize(event: KeyboardEvent) {
  const key = latinKey(event);
  if (key !== event.key) Object.defineProperty(event, "key", { value: key });
}
