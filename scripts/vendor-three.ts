// Builds the vendored three.js r186 bundle used inside free-object frames.
// Output: vendor/three-r186.js (IIFE) exposing self.ELABORA_THREE = { THREE, addons }.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const threeDir = path.dirname(new URL(import.meta.resolve('three/package.json')).pathname);
const threePkg = JSON.parse(fs.readFileSync(path.join(threeDir, 'package.json'), 'utf8'));
if (threePkg.version !== '0.186.0') throw new Error(`three ${threePkg.version} installed; Elabora 0.1 pins 0.186.0 (r186).`);
const entry = `
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
self.ELABORA_THREE = { version: 'r186', THREE, addons: { 'loaders/GLTFLoader.js': { GLTFLoader }, 'controls/OrbitControls.js': { OrbitControls } } };
`;
const result = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  bundle: true, format: 'iife', minify: true, target: 'es2020', write: false, legalComments: 'none', logLevel: 'error'
});
const banner = `/* three.js r186 (0.186.0) — MIT License, Copyright © 2010-2026 three.js authors. Vendored by Elabora for free objects. */\n`;
const vendor = path.join(root, 'packages/node/vendor');
fs.mkdirSync(vendor, { recursive: true });
fs.writeFileSync(path.join(vendor, 'three-r186.js'), banner + result.outputFiles[0].text);
fs.copyFileSync(path.join(threeDir, 'LICENSE'), path.join(vendor, 'three-LICENSE.txt'));
console.log(`vendor/three-r186.js ${(result.outputFiles[0].text.length / 1024).toFixed(0)} KB`);
