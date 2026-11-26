---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

A module opens and keeps what is made in a private window of Safari or Firefox, which have no private file system: its media are kept in IndexedDB (as bytes where WebKit refuses a Blob there), a master is made in memory, and a voice's takes are kept in memory for the session's life.
