import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared inventory for MCP resources and CLI reading. Names cannot traverse out of skills/.
export const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const safeName = (name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

export function skillPath(name: string, reference?: string): string | null {
  if (!safeName(name) || (reference !== undefined && !safeName(reference))) return null;
  const file = path.join(SKILLS_DIR, name, ...(reference ? ['references', `${reference}.md`] : ['SKILL.md']));
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

export interface SkillEntry { name: string; description: string; references: string[] }

// A skill's `description:` line, from the front matter of its SKILL.md.
function skillDescription(file: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
  return /^description:\s*(.+)$/m.exec(front)?.[1].trim() ?? '';
}

export function listSkills(): SkillEntry[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR).filter((name) => skillPath(name) !== null).sort().map((name) => {
    const dir = path.join(SKILLS_DIR, name, 'references');
    const references = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.md') && skillPath(name, file.slice(0, -3)) !== null).map((file) => file.slice(0, -3)).sort() : [];
    return { name, description: skillDescription(skillPath(name)!), references };
  });
}

export function readSkill(name: string, reference?: string): string | null {
  const file = skillPath(name, reference);
  return file === null ? null : fs.readFileSync(file, 'utf8');
}
