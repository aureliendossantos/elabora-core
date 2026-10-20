// Globals of the web platform that browsers, workers and Node all provide, and that the core uses.
// The core compiles with the ECMAScript library only ("types": [], no DOM): these few are declared
// here rather than taken from the DOM or Node typings, so nothing else slips in.
declare function structuredClone<T>(value: T): T;

declare class TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}

// Importers decode the base64 course data of Rise exports (import/rise.ts).
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
declare function atob(data: string): string;
