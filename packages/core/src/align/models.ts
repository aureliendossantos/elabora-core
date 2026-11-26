// The word aligner's models, pinned file by file (size, SHA-256), the same on both hosts: the desktop
// downloads them into its data folder, a browser into the origin's private file system.
import type { ModelFile } from '../util/model-files.ts';

// The word aligner's models (docs/decisions.md D27): a wav2vec2 CTC character model per language,
// downloaded on the first alignment in that language, pinned to a revision.
//
// French: jonatasgrosman/wav2vec2-large-xlsr-53-french (Apache-2.0) at revision 7c79e10, exported to
// ONNX (opset 17) with its matrix products quantized to int8; the file is XDcobra's export, pinned,
// which aligns as our own export of the same revision does. English:
// facebook/wav2vec2-base-960h (Apache-2.0) as Xenova's quantized ONNX export.
//
// Those exports are individuals' repositories, which could be renamed or deleted: every file is
// downloaded from Elabora's own copy in its Hugging Face organization (docs/decisions/D57.md), an
// unmodified mirror, byte for byte, so the sizes and SHA-256 are the upstream's. The upstream of each
// is named beside its constant.

export interface AlignerModel {
  version: string;            // the release a folder is installed at
  id: string;                 // its folder
  language: string;           // primary language subtag
  model: string;              // what a sidecar records as its aligner
  credit: string;             // the model and its licence (notices)
  files: ModelFile[];         // model.onnx and vocab.json
  // Measured on Pocket TTS voices (D27): word starts come about a frame late and ends early.
  startShift: number;         // seconds added to every word start
  endShift: number;           // seconds added to every word end, up to the next word's start
}

// Mirror of XDcobra/wav2vec2-large-xlsr-53-french-ONNX at feb7081bd901fc393812dddd9b0768ae05f730bf.
const XDCOBRA = 'elabora/wav2vec2-large-xlsr-53-french-onnx/resolve/fc9754dc06b837bed27113a60c2521b5377cbb4b';
// Mirror of jonatasgrosman/wav2vec2-large-xlsr-53-french at 7c79e105a6525d38e1e69f640b974b4a679723cc (its vocab.json alone).
const JONATAS = 'elabora/wav2vec2-large-xlsr-53-french/resolve/dc59d3c754de8aa70f134a69d5a10d2767f8cac0';
// Mirror of Xenova/wav2vec2-base-960h at a19f851b3d42865797e410752b4c570c871e4825.
const XENOVA = 'elabora/wav2vec2-base-960h-onnx/resolve/045b40925359ddb3fdb15aa2ae4141e61cc90ebc';

export const ALIGNER_MODELS: readonly AlignerModel[] = [
  {
    id: 'wav2vec2-xlsr53-french-int8',
    version: '7c79e10-feb7081',
    language: 'fr',
    model: 'wav2vec2-large-xlsr-53-french@7c79e10 int8',
    credit: 'wav2vec2-large-xlsr-53-french by Jonatas Grosman (Apache-2.0), converted to ONNX and quantized',
    files: [
      { name: 'model.onnx', url: `${XDCOBRA}/onnx/model_int8.onnx`, size: 355034715, sha256: 'fbe07a90dcb44f768f42d8eaed0154b5a2d44b9ee31bff40cf3234cadcfc2f88' },
      { name: 'vocab.json', url: `${JONATAS}/vocab.json`, size: 560, sha256: 'e83a3c849e480757fabd9fe927b870581e926407bcc7e1b6dcc8bda1e78a8d78' }
    ],
    startShift: -0.02,
    endShift: 0.034
  },
  {
    id: 'wav2vec2-base-960h-q8',
    version: 'a19f851',
    language: 'en',
    model: 'wav2vec2-base-960h@a19f851 quantized',
    credit: 'wav2vec2-base-960h by Meta AI (Apache-2.0), converted to ONNX and quantized by Xenova',
    files: [
      { name: 'model.onnx', url: `${XENOVA}/onnx/model_quantized.onnx`, size: 95286046, sha256: 'cd5040c147381580ed73258143dd8e0c28e800a09e74ee42ee2b3e8cb4d760a3' },
      { name: 'vocab.json', url: `${XENOVA}/vocab.json`, size: 358, sha256: '4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5' }
    ],
    startShift: -0.02,
    endShift: 0.112
  }
];

// A language's aligner: the course language tag or its primary subtag (fr-CA is French).
export function alignerOf(language: string, models: readonly AlignerModel[] = ALIGNER_MODELS): AlignerModel | null {
  const primary = language.toLowerCase().split('-')[0];
  return models.find((model) => model.language === primary) ?? null;
}
