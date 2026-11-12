import type { Node } from "ts-morph";

/** Replace `text.slice(start, end)` with `text`. Ranges come from the untouched original file. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(source: string, edits: TextEdit[]): string {
  const unique = [...new Map(edits.map((e) => [`${e.start}:${e.end}:${e.text}`, e])).values()];
  unique.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of unique) {
    if (edit.end > floor) throw new Error(`overlapping edits at offset ${edit.start}`);
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

/** Deletes a node; when it sits alone on its line(s), the whole lines go with it. */
export function removeNode(node: Node): TextEdit {
  const text = node.getSourceFile().getFullText();
  let start = node.getStart();
  let end = node.getEnd();
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = text.length;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (/^\s*$/.test(before) && /^[\s;]*$/.test(after)) {
    start = lineStart;
    end = Math.min(lineEnd + 1, text.length);
  }
  return { start, end, text: "" };
}

/** Deletes one element of a comma-separated list (properties, specifiers), with its comma. */
export function removeListElement(element: Node, siblings: readonly Node[]): TextEdit {
  const text = element.getSourceFile().getFullText();
  const lineStart = text.lastIndexOf("\n", element.getStart() - 1) + 1;
  let lineEnd = text.indexOf("\n", element.getEnd());
  if (lineEnd === -1) lineEnd = text.length;
  const ownLine = /^\s*$/.test(text.slice(lineStart, element.getStart())) && /^\s*,?\s*$/.test(text.slice(element.getEnd(), lineEnd));
  if (ownLine) return { start: lineStart, end: Math.min(lineEnd + 1, text.length), text: "" };

  const index = siblings.indexOf(element);
  const next = siblings[index + 1];
  if (next) return { start: element.getStart(), end: next.getStart(), text: "" };
  const prev = siblings[index - 1];
  if (prev) return { start: prev.getEnd(), end: element.getEnd(), text: "" };
  return { start: element.getStart(), end: element.getEnd(), text: "" };
}

export function replaceNode(node: Node, text: string): TextEdit {
  return { start: node.getStart(), end: node.getEnd(), text };
}
