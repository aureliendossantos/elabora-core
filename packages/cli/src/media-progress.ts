import type { MediaJob } from '@elabora/node/media/jobs';

// Progress of media jobs on stderr, so that stdout stays the command's answer (--json included).
// In a terminal one line is rewritten; elsewhere (agents, logs) a line every 25 %.

const label = (job: MediaJob) => `${job.type === 'rendition' ? `${job.preset} rendition of ${job.input}` : job.type === 'import' ? `importing ${job.output}` : `optimising ${job.input}`}`;

export function mediaProgress(): { progress(job: MediaJob): void; complete(job: MediaJob): void } {
  const terminal = !!process.stderr.isTTY;
  const shown = new Map<string, number>();
  const clear = () => { if (terminal) process.stderr.write(`\r${' '.repeat(Math.min(process.stderr.columns || 80, 120) - 1)}\r`); };
  return {
    progress(job) {
      const percent = Math.floor(job.progress * 100);
      if (terminal) process.stderr.write(`\r  ${label(job)} ${percent}%`.slice(0, (process.stderr.columns || 80) - 1));
      else if (percent >= (shown.get(job.id) ?? -25) + 25) { shown.set(job.id, percent); console.error(`  ${label(job)} ${percent}%`); }
    },
    complete(job) {
      clear();
      const mark = job.status === 'done' ? '✔' : job.status === 'cancelled' ? '·' : '✘';
      console.error(`${mark} ${label(job)}: ${job.status}${job.error ? ` — ${job.error}` : ''}${job.warnings.length ? `\n  ${job.warnings.join('\n  ')}` : ''}`);
    }
  };
}
