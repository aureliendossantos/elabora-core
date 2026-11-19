// What the core's models ask of ONNX Runtime: the part of onnxruntime-common both hosts give, the
// desktop's onnxruntime-node and a browser's onnxruntime-web (docs/decisions/D114.md). A session is made
// by the host (from a file on disk, from bytes in a browser); the core only runs it.

export interface OnnxTensor {
  readonly dims: readonly number[];
  readonly type: string;
  readonly data: unknown;
  dispose?(): void;
}

export interface OnnxSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
  release?(): Promise<void>;
}

export interface OnnxRuntime {
  Tensor: new (type: 'float32' | 'int64' | 'int32' | 'bool', data: Float32Array | BigInt64Array | Int32Array | Uint8Array | boolean[], dims: readonly number[]) => OnnxTensor;
}
