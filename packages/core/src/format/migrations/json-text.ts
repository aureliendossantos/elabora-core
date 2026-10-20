import type { Json } from '../../ops/types.ts';
import { sameJson } from '../../ops/json.ts';
import { stringifyJSON } from '../../util/json.ts';

// A JSON document edited in its text, so that a format migration changes the values it must and
// keeps the rest of the file as its author wrote it (one block per line, compact objects…): a
// migrated project differs from the original by the migrated values only. Every edit is also made
// on the parsed value; if the edited text does not give that value (a layout the scanner does not
// expect), the document is written with Elabora's formatting instead.

export type JsonPath = readonly (string | number)[];

interface Node {
  start: number; // the value: [start, end) in the text
  end: number;
  members?: Member[]; // objects
  items?: Node[]; // arrays
}

interface Member {
  key: string;
  start: number; // the opening quote of the key
  value: Node;
}

export class JsonText {
  private text: string;
  private current: Json;

  // text must be valid JSON (JSON.parse accepts it).
  constructor(text: string) {
    this.text = text;
    this.current = JSON.parse(text) as Json;
  }

  get value(): Json {
    return this.current;
  }

  // Replaces the value at path, which must exist.
  set(path: JsonPath, value: Json): void {
    const node = locate(scan(this.text), path);
    this.text = `${this.text.slice(0, node.start)}${JSON.stringify(value)}${this.text.slice(node.end)}`;
    this.current = edited(this.current, path, (parent, key) => { Reflect.set(parent, key, value); });
  }

  // Removes the member (or array item) at path, with its separator.
  remove(path: JsonPath): void {
    const parent = locate(scan(this.text), path.slice(0, -1));
    const key = path[path.length - 1];
    const spans = parent.members ? parent.members.map((m) => ({ start: m.start, end: m.value.end, key: m.key as string | number }))
      : (parent.items ?? []).map((item, i) => ({ start: item.start, end: item.end, key: i as string | number }));
    const i = spans.findIndex((span) => span.key === key);
    if (i < 0) throw new Error(`No ${String(key)} at ${JSON.stringify(path.slice(0, -1))}`);
    let from: number;
    let to: number;
    if (spans.length === 1) { from = parent.start + 1; to = parent.end - 1; } // {} or []
    else if (i < spans.length - 1) { from = spans[i].start; to = spans[i + 1].start; } // up to the next member
    else { from = spans[i - 1].end; to = spans[i].end; } // the last one: from the end of the previous
    this.text = `${this.text.slice(0, from)}${this.text.slice(to)}`;
    this.current = edited(this.current, path, (container, last) => {
      if (Array.isArray(container)) container.splice(Number(last), 1);
      else Reflect.deleteProperty(container, last);
    });
  }

  // The edited text, or the edited value in Elabora's formatting when the text edits went astray.
  toString(): string {
    let parsed: unknown;
    try { parsed = JSON.parse(this.text); } catch { return stringifyJSON(this.current); }
    return sameJson(parsed as Json, this.current) ? this.text : stringifyJSON(this.current);
  }
}

// A copy of a document with the container of path changed by change(container, last key).
function edited(document: Json, path: JsonPath, change: (container: object, key: string | number) => void): Json {
  const copy = structuredClone(document);
  let container: unknown = copy;
  for (const key of path.slice(0, -1)) container = Reflect.get(container as object, key);
  if (!container || typeof container !== 'object') throw new Error(`No ${JSON.stringify(path)} in the document`);
  change(container, path[path.length - 1]);
  return copy;
}

function locate(root: Node, path: JsonPath): Node {
  let node = root;
  for (const key of path) {
    const next = typeof key === 'number' ? node.items?.[key] : node.members?.find((m) => m.key === key)?.value;
    if (!next) throw new Error(`No ${JSON.stringify(path)} in the document`);
    node = next;
  }
  return node;
}

// Positions of the values of a JSON text that JSON.parse accepts.
function scan(text: string): Node {
  let at = 0;
  const space = () => { while (at < text.length && ' \t\n\r'.includes(text[at])) at++; };
  const string = (): void => {
    at++; // opening quote
    while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    at++;
  };
  const value = (): Node => {
    space();
    const start = at;
    const opening = text[at];
    if (opening === '{') {
      at++;
      const members: Member[] = [];
      space();
      while (text[at] !== '}') {
        const keyStart = at;
        string();
        const key = JSON.parse(text.slice(keyStart, at)) as string;
        space();
        at++; // colon
        members.push({ key, start: keyStart, value: value() });
        space();
        if (text[at] === ',') { at++; space(); }
      }
      at++;
      return { start, end: at, members };
    }
    if (opening === '[') {
      at++;
      const items: Node[] = [];
      space();
      while (text[at] !== ']') {
        items.push(value());
        space();
        if (text[at] === ',') { at++; space(); }
      }
      at++;
      return { start, end: at, items };
    }
    if (opening === '"') string();
    else while (at < text.length && !',]} \t\n\r'.includes(text[at])) at++;
    return { start, end: at };
  };
  return value();
}
