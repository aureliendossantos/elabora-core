import fs from 'node:fs';
import path from 'node:path';
import { packageDir } from './package-dir.ts';
import { fieldOf, isRecord } from './values.ts';

// axe-core (an optional dependency): its script is injected into pages, so it is read as text.
let axeSource: string | null | undefined;
export function loadAxe(): string | null {
  if (axeSource !== undefined) return axeSource;
  try {
    axeSource = fs.readFileSync(path.join(packageDir('axe-core') ?? '', 'axe.min.js'), 'utf8');
  } catch { axeSource = null; }
  return axeSource;
}

// A violation as the injected scripts report it.
export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  targets: string[];
}

// The violations an injected axe run returned (a page result: checked, not trusted).
export function axeViolations(result: unknown): AxeViolation[] {
  if (!Array.isArray(result)) throw new Error('axe-core returned no list of violations');
  return result.filter(isRecord).map((violation) => {
    const targets = fieldOf(violation, 'targets');
    return {
      id: String(violation.id),
      impact: typeof violation.impact === 'string' ? violation.impact : null,
      help: String(violation.help),
      nodes: Number(violation.nodes),
      targets: Array.isArray(targets) ? targets.map(String) : []
    };
  });
}
