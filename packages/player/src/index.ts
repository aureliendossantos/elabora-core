// Public API of @elabora/player. The entry points bundled into every package (player.ts and
// object-frame.ts) run in the page and in object frames: they are not exported here.

export type * from './course-data.ts';
export type * from './object-protocol.ts';
export type { JsonObject, JsonValue } from './json.ts';

export { createCourseState, behaviorOf, hasBehavior, isActivity, flatBlocks } from './course-state.ts';
export type { CourseState, CourseStateInput, CourseStateOptions, ChangeKind, Score, TargetStatus, TriggerInfo, EventRun, QuizResult, NumericResult } from './course-state.ts';
export { STATE_VERSION, emptyState, encodeState, decodeState, worstCaseState, worstCaseLength } from './state-codec.ts';
export type { LearnerState, StateModel, QuizAnswer, NumericAnswer } from './state-codec.ts';
export { parseNumber, withinTolerance, gradeNumeric, formatNumber } from './numeric.ts';
export { labelsFor, labelKeys, labelLanguages, formatLabel } from './labels.ts';
export type { Labels, LabelKey } from './labels.ts';
export { formatMessage } from './message.ts';
export { tokenCssVars, cssVarsRule } from './tokens.ts';
export { validateData } from './data-schema.ts';
export type { DataSchema, DataType } from './data-schema.ts';
export { createObjectHost } from './object-host.ts';
export type { ObjectHost, ObjectHostDefinition, ObjectHostOptions } from './object-host.ts';
export { findScorm12API, createScorm12Adapter, createStandaloneAdapter, scorm12Duration } from './scorm12.ts';
export type { Interaction, LmsAdapter, LmsCall, LmsPhase, Scorm12Api } from './scorm12.ts';
export { createWebAdapter, webStorageKey } from './web.ts';
export type { WebProgress, WebStorage, WebAdapterOptions } from './web.ts';
