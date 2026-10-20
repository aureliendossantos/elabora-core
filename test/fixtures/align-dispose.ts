// What a command does with the aligner's process: ask, then stop it and go on with the answer. The
// process is not held while idle, so once stopped the program has nothing else to wait for.
import { AlignProcess } from '@elabora/node/align/process';

const aligner = new AlignProcess(new URL('./align-stand-in.ts', import.meta.url).href);
const answer = await aligner.align({ dir: '', samples: new Float32Array(16000), text: 'bonjour', language: 'fr', startShift: 0, endShift: 0 });
await aligner.dispose();
console.log(`stopped after ${answer.words[0].text === 'bonjour' ? 'an alignment' : 'something else'}`);
