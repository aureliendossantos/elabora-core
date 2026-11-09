---
npm/elabora: patch (Added)
npm/@elabora/core: patch (Added)
npm/@elabora/engine: patch (Added)
---

A change can say the values it was decided on: the engine's `run` takes `expect` (a block's props, a translation unit's source and target) and checks them in its write queue, under the project lock, just before the command. A value changed meanwhile refuses the change with `E_EXPECTED`, and nothing is written.
