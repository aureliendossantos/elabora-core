import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate, renderTemplate } from '@elabora/core/components/template';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { renderScreen } from '@elabora/core/render/screen';
import { EXAMPLE } from '../helpers.ts';

// The app's canvas marks the texts the author can point at (data-t-field, a path below props);
// packages and captures never carry them.

const fieldsOf = (html: string) => [...html.matchAll(/data-t-field="([^"]+)"/g)].map((m) => m[1]);

test('templates mark an element whose whole content is one text prop, items of lists included', () => {
  const tpl = parseTemplate('<div class="card"><h3>{{title}}</h3><p>{{title}} et {{note}}</p><ul><li data-each="steps"><b>{{label}}</b><span>{{count}}</span></li></ul><i>{{@id}}</i><em>{{missing}}</em></div>');
  const props = { title: 'Le poste', note: 'n', steps: [{ label: 'Poste', count: 2 }, { label: 'Routeur', count: 3 }] };
  const marked = renderTemplate(tpl, { props, id: 'b1', fields: true }).html;
  assert.deepEqual(fieldsOf(marked), ['title', 'steps.0.label', 'steps.1.label']);
  assert.deepEqual(fieldsOf(renderTemplate(tpl, { props, id: 'b1' }).html), [], 'without the option, nothing is marked');
});

test('a screen rendered for the canvas marks the decision prompt and options; a plain render does not', () => {
  const project = loadProjectFromDir(EXAMPLE);
  const html = (fields: boolean) => JSON.stringify(renderScreen(project, 'premier-reflexe', { fields }).course.screens[0]);
  const marked = fieldsOf(html(true).replace(/\\"/g, '"'));
  assert.ok(marked.includes('prompt') && marked.includes('options.0.label') && marked.includes('options.2.label'), JSON.stringify(marked));
  assert.deepEqual(fieldsOf(html(false).replace(/\\"/g, '"')), []);
});
