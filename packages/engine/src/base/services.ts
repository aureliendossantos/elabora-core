import { EngineError } from './errors.ts';
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
  activity: ['activity']
};

export const SERVICES = Object.keys(SERVICE_REQUESTS) as Service[];

export const NOT_HERE = 'E_NOT_HERE';

const BY_REQUEST = new Map<RequestType, Service>(SERVICES.flatMap((service) => SERVICE_REQUESTS[service].map((type) => [type, service] as const)));

// The service a request belongs to; null: the session's own.
export const serviceOf = (type: RequestType): Service | null => BY_REQUEST.get(type) ?? null;

export const notHere = (type: RequestType, service: Service): EngineError =>
  new EngineError('not-available', `${type}: this session has no ${service} service`, { code: NOT_HERE });
