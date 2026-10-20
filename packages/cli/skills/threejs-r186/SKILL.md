---
name: threejs-r186
description: Pinned notes for writing three.js r186 (0.186.0) code inside Elabora free objects - API changes that models often get wrong, and the vendored build's constraints. Use when writing or fixing object.js files that import three.
---

# three.js r186 in Elabora

Elabora vendors three.js **r186** (0.186.0). Imports are mapped by the build: `import * as THREE from 'three'`. Only two addons are available: `three/addons/loaders/GLTFLoader.js`, `three/addons/controls/OrbitControls.js`. Official agent notes: https://threejs.org/docs/llms.txt (read from your own environment, not from the object).

## Changes models get wrong
- Colour management is on by default: hex colours are sRGB; `THREE.Color('#12355B')` is correct. `renderer.outputEncoding`, `texture.encoding` and `sRGBEncoding` no longer exist: use `texture.colorSpace = THREE.SRGBColorSpace` (canvas and image textures).
- Physically based light units are the default (no `physicallyCorrectLights`): typical values are `HemisphereLight(…, 2–3)` and `DirectionalLight(…, 2–3)`; point/spot lights need much larger intensities with `decay = 2`.
- `Geometry` is gone: only `BufferGeometry` and the built-in geometries (`BoxGeometry`, `SphereGeometry`, …).
- No CDN script, no `window.THREE` global, no import maps: the build handles modules.
- `WebGPURenderer` and TSL exist but are not vendored here: use `WebGLRenderer`.

## Elabora specifics
- Create one `WebGLRenderer` per object; call `host.registerRenderer(renderer)`; pass `preserveDrawingBuffer: ctx.testMode` so snapshots work; pixel ratio 1 in test mode.
- Render inside `host.onFrame(dt => { …; renderer.render(scene, camera); })`, never with `requestAnimationFrame`.
- Size from the container with a `ResizeObserver`; fit the camera to the scene width for any aspect ratio.
- Dispose geometries, materials, textures and the renderer in `dispose()`.
- Raycast on `click` for selection, and mirror every action with a DOM button for keyboard users.
