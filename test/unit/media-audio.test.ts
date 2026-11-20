import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findMediaTools } from '@elabora/node/media/index';
import { silenceTrim } from '@elabora/core/media/audio';

// A recorded line's silence cut by the core's rule (what a browser follows) as the desktop's ffmpeg
// cuts it (silenceremove at both ends, 0.1 s kept): the same number of samples kept, on sounds that
// start sharply, fade in, sit on a noise floor under or over the threshold, or never rise above it.

const run = promisify(execFile);
const tools = await findMediaTools().catch(() => null);
const SILENCE = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,areverse';
const SOUNDS: Record<string, string> = {
  sharp: 'if(between(t\\,1\\,2)\\,0.3*sin(2*PI*440*t)\\,0)|0',
  'fade in': 'if(between(t\\,0.8\\,2)\\,(t-0.8)*0.5*sin(2*PI*300*t)\\,0)|0',
  'quiet floor': '0.0005*(random(0)-0.5)+if(between(t\\,0.5\\,1.5)\\,0.2*sin(2*PI*200*t)\\,0)|0',
  'loud floor': '0.006*(random(0)-0.5)+if(between(t\\,0.5\\,1.5)\\,0.2*sin(2*PI*200*t)\\,0)|0',
  'stereo, one side': '0|if(between(t\\,0.4\\,0.9)\\,0.2*sin(2*PI*500*t)\\,0)',
  'under the threshold': 'if(between(t\\,0.3\\,0.6)\\,0.004*sin(2*PI*200*t)\\,0)|0'
};

const raw = async (source: string, filters: string[] = []) => {
  const { stdout } = await run(tools!.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${source}:s=48000:d=2.4`, ...filters, '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4);
};

test('a line\'s silence: the core keeps the samples ffmpeg keeps', async (t) => {
  if (!tools) return t.skip('ffmpeg not found');
  for (const [name, source] of Object.entries(SOUNDS)) {
    const interleaved = await raw(source);
    const channels = [0, 1].map((c) => interleaved.filter((_, i) => i % 2 === c));
    const kept = (await raw(source, ['-af', SILENCE])).length / 2;
    const { start, end } = silenceTrim(channels, 48000);
    assert.equal(end - start, kept, name);
  }
});
