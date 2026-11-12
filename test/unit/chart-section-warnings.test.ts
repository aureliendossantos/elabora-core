import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';
import * as edit from '@elabora/node/edit';
import { validateDir } from '@elabora/node/project-reader';

// Two warnings (D92): a chart's item the voice brings before the chart appears, and a screen in a
// section of another part of the plan. Warnings only: they refuse no change and block no release.

const PHISHING = path.join(ROOT, 'examples/phishing-by-numbers');
const found = (dir: string, code: string) => validateDir(dir).diagnostics.filter((d) => d.code === code);

test('a chart\'s item brought before the chart appears, at its timing.in or at its step, is a warning that says which and when', () => {
  const dir = copyExample(PHISHING);
  // The bars come with "websites" (line l2): the voice brings the email row at "email", in l1.
  edit.setBlockTiming(dir, { block: 'origins-bars', in: { at: { line: 'l2', word: 'websites' } } });
  let warnings = found(dir, 'W_CHART_ITEM_BEFORE_BLOCK');
  assert.deepEqual(warnings.map((d) => [d.severity, d.file, d.path, d.target]), [['warning', 'screens/origins.json', '/blocks/0/props/rows/0/at', 'origins-bars']]);
  assert.match(warnings[0]!.message, /^Chart "origins-bars" of screen "origins": the voice brings its item "email" at [\d.]+ s, before the chart appears \([\d.]+ s, its timing\.in\): learners never see that item come\.$/);
  // Anchored after the chart is there: nothing.
  edit.setBlockTiming(dir, { block: 'origins-bars', in: null });
  assert.deepEqual(found(dir, 'W_CHART_ITEM_BEFORE_BLOCK'), []);
  // The chart in step 2, the line that brings its email row in step 1.
  const screen = readJSON(dir, 'screens/origins.json');
  screen.narration.lines[1].step = 2;
  screen.blocks[0].step = 2;
  writeJSON(dir, 'screens/origins.json', screen);
  warnings = found(dir, 'W_CHART_ITEM_BEFORE_BLOCK');
  assert.deepEqual(warnings.map((d) => d.path), ['/blocks/0/props/rows/0/at']);
  assert.match(warnings[0]!.message, /when step 2 opens/);
});

test('a screen in a section of another part of the plan is a warning that names the screen, the section and both parts', () => {
  const dir = copyExample(PHISHING);
  // clicked covers ITEM-5, of the part « Your move »; « The threat » is the section's part.
  edit.moveScreen(dir, { id: 'clicked', section: 'threat' });
  const warnings = found(dir, 'W_SCREEN_OUTSIDE_PART');
  assert.deepEqual(warnings.map((d) => [d.severity, d.file, d.path, d.target]), [['warning', 'course.json', '/sections/0/screens/3', 'clicked']]);
  assert.equal(warnings[0]!.message, 'Screen "clicked" is in section "threat", of the plan\'s part « The threat », while its item ITEM-5 is in part « Your move »: the section no longer follows its part when the plan\'s parts move.');
  // Back in a section of its part: nothing.
  edit.moveScreen(dir, { id: 'clicked', section: 'your-move' });
  assert.deepEqual(found(dir, 'W_SCREEN_OUTSIDE_PART'), []);
  // A section named after no part, with as many screens of each: no part is its own, nothing said.
  const course = readJSON(dir, 'course.json');
  course.sections[1].title = 'Numbers';
  course.sections[1].screens = ['funnel', 'drills'];
  course.sections[2].screens = ['lure-map', 'reports', 'rules'];
  writeJSON(dir, 'course.json', course);
  assert.deepEqual(found(dir, 'W_SCREEN_OUTSIDE_PART').map((d) => d.target), ['lure-map']);
});

test('the examples have neither warning', () => {
  for (const name of fs.readdirSync(path.join(ROOT, 'examples')).filter((each) => fs.existsSync(path.join(ROOT, 'examples', each, 'course.json')))) {
    const codes = validateDir(path.join(ROOT, 'examples', name)).diagnostics.map((d) => d.code);
    assert.ok(!codes.includes('W_CHART_ITEM_BEFORE_BLOCK') && !codes.includes('W_SCREEN_OUTSIDE_PART'), name);
  }
});
