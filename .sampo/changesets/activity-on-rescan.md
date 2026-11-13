---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

An agent's activity line that the file watcher missed (FSEvents drops events under heavy disk activity, and Node does not say so) now shows at the session's next rescan, every 15 s by default, and never twice.
