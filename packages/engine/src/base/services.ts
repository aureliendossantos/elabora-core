import { EngineError } from './errors.ts';
import type { HostNeed } from '@elabora/core/commands/host';
import type { RequestType, Service } from '../protocol.ts';

// The services a session may have, and the requests of each (D102). A host gives the ones it has; a
// request of another answers not-available with code E_NOT_HERE, so that the window says it is not
// here rather than that it failed. Every other request is the session's own: the project, its reads
// and changes, its history, its copy in the cloud.

export const SERVICE_REQUESTS: Record<Service, readonly RequestType[]> = {
  media: ['importMedia', 'mediaJobs', 'cancelMediaJob', 'narrationPeaks', 'importNarrationFiles'],
  voices: ['voices', 'installVoices', 'setSpeakerVoice', 'generateVoice', 'voiceTakes', 'cancelVoice', 'voiceSample', 'voiceEstimate', 'setVoiceKey', 'voiceAccount', 'voiceSearch'],
  align: ['aligners', 'alignNarration'],
  transcribe: ['transcribers', 'transcribeRecording', 'transcriptionEstimate', 'transcribeLine'],
  sounds: ['soundSearch', 'soundPreview', 'soundEstimate', 'generateSound'],
  build: ['build', 'buildTranslation', 'packageWeights'],
  canvas: ['openCanvas', 'canvasView', 'closeCanvas'],
  backups: ['backups', 'createBackup', 'restoreBackup'],
  documents: ['planDocumentPage', 'exportPlanDocument', 'dialoguePage', 'exportDialogue'],
  activity: ['activity'],
  // No request: the commands whose need is the computer's libraries (NEED_SERVICES).
  library: []
};

export const SERVICES = Object.keys(SERVICE_REQUESTS) as Service[];

export const NOT_HERE = 'E_NOT_HERE';

const BY_REQUEST = new Map<RequestType, Service>(SERVICES.flatMap((service) => SERVICE_REQUESTS[service].map((type) => [type, service] as const)));

// The service a request belongs to; null: the session's own.
export const serviceOf = (type: RequestType): Service | null => BY_REQUEST.get(type) ?? null;

export const notHere = (type: RequestType, service: Service): EngineError =>
  new EngineError('not-available', `${type}: this session has no ${service} service`, { code: NOT_HERE });

// The service a command's need belongs to (D102, D104): a command whose service the session does not
// have answers not here, before it runs.
export const NEED_SERVICES: Record<HostNeed, Service> = {
  lineAudio: 'media', recording: 'media', resourceFile: 'media', videoOfImage: 'media',
  heardText: 'transcribe', sound: 'sounds',
  font: 'library', objectTemplates: 'library', libraryComponent: 'library', componentMigrations: 'library', publication: 'library'
};

// Every request of the protocol, checked complete by the compiler (a request missing here would be
// refused as bad-request).
const REQUEST_TYPES: Record<RequestType, true> = {
  summary: true, readFile: true, listFiles: true, readScreen: true, screenParts: true, findText: true, conversions: true, translationStatus: true,
  translationTable: true, screenTranslation: true, buildTranslation: true, run: true, undo: true, redo: true, undoBatch: true, history: true, mark: true, endTurn: true,
  diagnostics: true, importMedia: true, mediaJobs: true, activity: true, cancelMediaJob: true, backups: true, createBackup: true, restoreBackup: true,
  renderScreen: true, openCanvas: true, canvasView: true, closeCanvas: true, migrate: true, build: true, packageWeights: true, close: true, relayPort: true, narration: true, voices: true,
  installVoices: true, setSpeakerVoice: true, generateVoice: true, voiceTakes: true, cancelVoice: true, voiceSample: true, aligners: true,
  setVoiceKey: true, voiceAccount: true, voiceSearch: true, voiceEstimate: true, soundSearch: true, soundPreview: true, courseSounds: true, soundEstimate: true, generateSound: true,
  alignNarration: true, timeline: true, timelineAt: true, timelineMarks: true, narrationPeaks: true, importNarrationFiles: true, planVoiceover: true, planVersions: true, planDiff: true, planDocument: true, planDocumentPage: true, exportPlanDocument: true, dialogue: true, dialoguePlay: true, dialoguePage: true, exportDialogue: true, effects: true, transcribeRecording: true, transcribers: true, transcriptionEstimate: true, transcribeLine: true
};

export const isRequestType = (type: string): type is RequestType => Object.hasOwn(REQUEST_TYPES, type);
