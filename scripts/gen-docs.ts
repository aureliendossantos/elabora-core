// Generates docs/diagnostics.md, docs/lms-profiles.md, docs/blocks.md, docs/cli.md, docs/mcp-tools.md
// and the index of docs/decisions/ (docs/decisions.md) from the code, the schemas and the decisions.
import fs from 'node:fs';
import path from 'node:path';
import { CODES } from '@elabora/core/diagnostics/codes';
import { RULES } from '@elabora/core/diagnostics/rules';
import type { CodeInfo } from '@elabora/core/diagnostics/codes';
import { listProfiles } from '@elabora/core/lms/profiles';
import { getSchema, BLOCK_TYPES, LAYOUT_TYPES, FORMAT_VERSION, SCHEMA_VERSION } from '@elabora/format/schemas';
import type { JsonSchema } from '@elabora/format';
import { BUILTINS, BEHAVIORS } from '@elabora/core/components/registry';
import { GROUPS } from '@elabora/cli/main';
import { listAgentTools } from '@elabora/cli/agent-tools';

// Placeholders such as <id> or --section <s> are words, not HTML: escaped outside code spans, so that
// GitHub and the site show them.
const prose = (value: unknown) => String(value ?? '').split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;'))).join('');
const cell = (value: unknown) => prose(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const groups = [['E_', 'Errors (block the build)'], ['W_', 'Warnings'], ['I_', 'Information']];
let d = '# Diagnostic codes\n\nGenerated from `packages/core/src/diagnostics/codes.ts` by `npm run docs`. Codes are stable: agents can branch on them. `rule` names a pedagogical guardrail (A1…I1) or a line of the LMS delivery checklist (LMS-n): see [Rules](#rules). An error under a rule stops a build but not a preview (`elabora preview`, the app\'s Aperçu): the course runs without what the rule asks, and the preview shows it as it is.\n';
for (const [prefix, title] of groups) {
  d += `\n## ${title}\n\n| Code | Title | Fix | Rule |\n|---|---|---|---|\n`;
  for (const [code, c] of Object.entries<CodeInfo>(CODES).filter(([k]) => k.startsWith(prefix))) d += `| \`${code}\` | ${cell(c.title)} | ${cell(c.fix)} | ${c.rule || ''} |\n`;
}
const citing = (rule: string) => Object.entries<CodeInfo>(CODES).filter(([, c]) => c.rule === rule).map(([code]) => `\`${code}\``);
d += '\n## Rules\n\nWhat each rule asks, as Elabora checks it (`packages/core/src/diagnostics/rules.ts`), and the codes that cite it.\n\n| Rule | What it asks | Codes |\n|---|---|---|\n';
for (const [rule, text] of Object.entries(RULES)) d += `| ${rule} | ${cell(text)} | ${citing(rule).join(', ')} |\n`;
fs.writeFileSync('docs/diagnostics.md', d);

let p = '# LMS profiles\n\nGenerated from `profiles/*.json`. "?" = not documented: to be measured in a real instance (`toMeasure`).\n\n| Profile | Documented | SCORM 1.2 | SCORM 2004 | cmi5 | Launch | suspend_data 1.2 | Package | Update |\n|---|---|---|---|---|---|---|---|---|\n';
for (const x of listProfiles()) {
  const pk = [x.packaging?.maxZipMB ? `≤ ${x.packaging.maxZipMB} MB` : null, x.packaging?.maxUnzippedMB ? `≤ ${x.packaging.maxUnzippedMB} MB extracted` : null, x.packaging?.maxFiles ? `≤ ${x.packaging.maxFiles} files` : null, x.packaging?.maxCompressionRatio ? `ratio ≤ ${x.packaging.maxCompressionRatio}` : null].filter(Boolean).join(', ') || '?';
  p += `| **${x.id}** — ${cell(x.name)} | ${x.documentedAt} | ${x.standards.scorm12 ? '✔' : '✘'} | ${x.standards.scorm2004 == null ? '?' : x.standards.scorm2004.length ? x.standards.scorm2004.join(', ') : '✘'} | ${x.standards.cmi5 ?? '?'} | ${x.launch.modes.join(', ')} | ${x.datamodel?.suspendDataMax?.scorm12 ?? '?'}${x.datamodel?.suspendDataEnforcement ? ` (${x.datamodel.suspendDataEnforcement})` : ''} | ${pk} | ${x.update?.family ?? '?'} |\n`;
}
p += '\n## Notes\n';
for (const x of listProfiles()) if (x.notes?.length) p += `\n**${prose(x.name)}**\n${x.notes.map((n) => `- ${prose(n)}`).join('\n')}\n${x.sources.length ? `- Sources: ${x.sources.map((s) => `[${s.title}](${s.url})`).join(' · ')}\n` : ''}`;
fs.writeFileSync('docs/lms-profiles.md', p);

let b = `# Built-in block catalogue (format elabora/${FORMAT_VERSION}, schemas ${SCHEMA_VERSION})\n\nGenerated from \`packages/format/schemas/${SCHEMA_VERSION}/blocks/\` and the built-in components (\`packages/core/src/components/builtin/\`). Agents: call \`elabora_get_schema <type>\` for the full schema; course components are listed by \`elabora_list_components\` (docs/components.md).\n`;
for (const t of BLOCK_TYPES) {
  const s = getSchema(`blocks/${t}`);
  const bi = BUILTINS[t];
  const bh = bi.behavior && BEHAVIORS[bi.behavior];
  const how = bi.render === 'code' ? 'Rendered by code: cannot be forked; place it in a component slot.' : `Template \`packages/core/src/components/builtin/${t}.html\`: fork it to change the markup${bh ? `; the fork keeps the ${bi.behavior} behaviour and must provide ${bh.required.length ? bh.required.map((h) => `\`data-t-${h}\``).join(', ') : `one of ${(bh.anyOf ?? []).map((h) => `\`data-t-${h}\``).join(', ')}`}` : ''}.`;
  b += `\n## \`${t}\` (${s['x-category']})\n\n${prose(s.description)}\n\n${s['x-ai-instructions'] ? `> ${prose(s['x-ai-instructions'])}\n\n` : ''}${how}\n\n| Prop | Type | Required | Description |\n|---|---|---|---|\n`;
  for (const [k, property] of Object.entries(s.properties || {})) {
    const v: JsonSchema = typeof property === 'boolean' ? {} : property;
    const type = v.enum ? v.enum.map((e) => JSON.stringify(e)).join(' \\| ') : v.$ref ? v.$ref.split('/').pop() : v.type || 'object';
    b += `| \`${k}\` | ${type} | ${(s.required || []).includes(k) ? 'yes' : ''} | ${cell(v.description || '')}${v.default !== undefined ? ` Default ${JSON.stringify(v.default)}.` : ''} |\n`;
  }
}
// Built-in screen layouts (D63): a screen names one in layout; their slots are in their schema (x-slots).
b += `\n# Built-in screen layouts\n\nGenerated from \`packages/format/schemas/${SCHEMA_VERSION}/layouts/\`. A screen uses one with \`"layout": "<id>"\` and its \`layoutProps\`; blocks choose a slot with \`slot\` (docs/components.md).\n`;
for (const t of LAYOUT_TYPES) {
  const s = getSchema(`layouts/${t}`);
  const slots = (s['x-slots'] as { id: string; description?: string; default?: boolean; accepts?: string[] }[] | undefined) ?? [];
  b += `\n## \`${t}\` (${s['x-category']})\n\n${prose(s.description)}\n\n${s['x-ai-instructions'] ? `> ${prose(s['x-ai-instructions'])}\n\n` : ''}Template \`packages/core/src/components/builtin/${t}.html\`: fork it (a screen-level component that extends it) to change the markup. Slots: ${slots.map((slot) => `\`${slot.id}\`${slot.default ? ' (default)' : ''}${slot.accepts ? ` (${slot.accepts.join(', ')})` : ''}`).join(', ')}.\n\n| Prop | Type | Required | Description |\n|---|---|---|---|\n`;
  for (const [k, property] of Object.entries(s.properties || {})) {
    const v: JsonSchema = typeof property === 'boolean' ? {} : property;
    const type = v.enum ? v.enum.map((e) => JSON.stringify(e)).join(' \\| ') : v.$ref ? v.$ref.split('/').pop() : v.type || 'object';
    b += `| \`${k}\` | ${type} | ${(s.required || []).includes(k) ? 'yes' : ''} | ${cell(v.description || '')}${v.default !== undefined ? ` Default ${JSON.stringify(v.default)}.` : ''} |\n`;
  }
}
fs.writeFileSync('docs/blocks.md', b);
// The command line, as its help prints it, one section per group of commands.
let c = '# Command line\n\nGenerated from the help of `elabora` by `npm run docs`: `elabora help` prints the same, and `elabora <command> --help` one group. `[dir]` is a course folder (the current one by default). Run it from a checkout with `node bin/elabora.js`, or through the desktop app\'s bundled command.\n';
for (const group of GROUPS) c += `\n## ${prose(group.title)}\n\n\`\`\`text\n${group.help.replace(/^  /gm, '')}\n\`\`\`\n`;
fs.writeFileSync('docs/cli.md', c);

// The agent operations (MCP tools, and elabora tools call): description and arguments.
const typeOf = (v: JsonSchema): string => v.enum ? v.enum.map((e) => JSON.stringify(e)).join(' \\| ') : v.type === 'array' ? `${v.items && typeof v.items === 'object' && !Array.isArray(v.items) ? typeOf(v.items as JsonSchema) : 'any'}[]` : Array.isArray(v.type) ? v.type.join(' \\| ') : v.type || (v.oneOf || v.anyOf ? 'one of several' : 'object');
const tools = listAgentTools();
let m = `# Agent tools\n\nGenerated from the agent operation catalogue (\`packages/cli/src/agent-tools.ts\`) by \`npm run docs\`. The same ${tools.length} operations are MCP tools (\`elabora mcp <course>\`) and shell calls (\`elabora tools call <tool> <course> --args '<json>'\`); [Working with an agent](agents.md) says how to choose. Read tools change nothing in the course; every write is journaled and undoable and returns the diagnostics it caused.\n`;
for (const [title, read] of [['Reading', true], ['Writing', false]] as const) {
  m += `\n## ${title}\n`;
  for (const tool of tools.filter((t) => t.annotations.readOnlyHint === read)) {
    const schema = tool.inputSchema as JsonSchema;
    const props = Object.entries(schema.properties || {});
    m += `\n### \`${tool.name}\`\n\n${prose(tool.description)}\n`;
    if (props.length) {
      m += '\n| Argument | Type | Required | Description |\n|---|---|---|---|\n';
      for (const [k, property] of props) {
        const v: JsonSchema = typeof property === 'boolean' ? {} : property;
        m += `| \`${k}\` | ${typeOf(v)} | ${(schema.required || []).includes(k) ? 'yes' : ''} | ${cell(v.description || '')}${v.default !== undefined ? ` Default ${JSON.stringify(v.default)}.` : ''} |\n`;
      }
    }
  }
}
fs.writeFileSync('docs/mcp-tools.md', m);

// The decision log's index, from the decisions themselves (docs/decisions/Dnn.md, « # Dn. Title (date) »).
let x = '# Decisions\n\nGenerated from `docs/decisions/` by `npm run docs`. One file per decision: what was decided, why, and what would make us revisit it (*Revisit if*). Code, docs and changelog cite them by number (D24); a decision replaced or revised says by which one.\n\n| | Decision | Date |\n|---|---|---|\n';
for (const file of fs.readdirSync('docs/decisions').filter((f) => /^D\d+\.md$/.test(f)).sort()) {
  const head = /^# (D\d+)\. (.*?)(?: \(([^()]*\d{4}[^()]*)\))?$/m.exec(fs.readFileSync(path.join('docs/decisions', file), 'utf8'));
  if (!head) throw new Error(`docs/decisions/${file} does not start with « # Dn. Title (date) »`);
  x += `| [${head[1]}](decisions/${file}) | ${cell(head[2])} | ${cell(head[3] || '')} |\n`;
}
fs.writeFileSync('docs/decisions.md', x);
console.log('docs/diagnostics.md, docs/lms-profiles.md, docs/blocks.md, docs/cli.md, docs/mcp-tools.md, docs/decisions.md');
