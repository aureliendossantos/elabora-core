// Media pipeline of @elabora/node: masters at the high preset in a web format, renditions for the
// lower presets, background jobs. See docs/architecture/media.md.
export { PRESETS, PRESET_NAMES, CANONICAL, MEDIA_PIPELINE_VERSION, isPresetName, presetParameters, presetHash, fitWithin } from '@elabora/core/media/presets';
export type { MediaKind, PresetName, Preset, VideoPreset, AudioPreset, ImagePreset } from '@elabora/core/media/presets';
export { conformance, fileMedia, masterPlan, renditionPlan, canonicalPath, presetDimensions, imageExtension, mediaKindOfPath, extensionOf, replaceExtension, MEDIA_EXTENSIONS } from '@elabora/core/media/conformance';
export type { MediaInfo, FileMedia, Conformance, ConformanceReason, ConformanceFix, MediaPlan, PlanOptions } from '@elabora/core/media/conformance';
export { findMediaTools, findProberSync, MediaToolsError } from './tools.ts';
export type { MediaTools, H264Encoder, Prober } from './tools.ts';
export { probeMedia, probeMediaSync, probeProjectMedia, probeProjectMediaSync, probeProjectFile, readMp4Layout, readMp4LayoutSync, MediaProbeError, probeCachePath } from './probe.ts';
export { projectFileHash, projectFileHashSync } from '../file-hash.ts';
export type { Mp4Layout, ProjectMedia, ListedMediaFile } from './probe.ts';
export { readImageMetadata, stripImageMetadata } from './metadata.ts';
export { encodeAttempts, encodeMedia, runFfmpeg, MediaEncodeError } from './encode.ts';
export type { EncodeRequest, EncodeAttempt, EncodeResult } from './encode.ts';
export { MediaQueue, getMediaQueue, readJobs, pendingOutputs, isFinished, jobsDir, jobOutputFile } from './jobs.ts';
export type { MediaJob, MediaJobType, MediaJobStatus, NewMediaJob } from './jobs.ts';
export { importMedia, optimizeInPlace, uniquePath, MEDIA_FOLDERS } from './import.ts';
export type { ImportOptions, ImportResult, OptimizeResult } from './import.ts';
export { renditionPath, ensureRendition, renditionsDir, pruneRenditions } from './renditions.ts';
export type { RenditionResult } from './renditions.ts';
export { slugify } from './files.ts';
export { optimizeMedia, mediaToOptimize } from './optimize.ts';
export type { OptimizeMediaOptions, OptimizeMediaResult, OptimizedMedia } from './optimize.ts';
