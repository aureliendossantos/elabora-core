---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: patch (Changed)
---

Foundations of projects in the cloud (docs/architecture/sync.md). `@elabora/core` `sync/`: the protocol `elabora-sync/1`, `rebase` (an operation applies when the value it replaces is still there; otherwise a person's value wins and what it replaced is reported, an agent's gives way and is reported; whole values merge three ways first; D74), the server's placing of a change (`acceptChange`: once per id, rebased, validated, numbered; D73), a copy's model (`SyncClient`: confirmed files, waiting changes rebased on top, one in flight, offline and back), and `externalEdit`, which computes a file written by an agent's own tools from the version it most likely read (D75). `executeCommand` runs a command on files and returns its change (D76); the executor of `@elabora/node` calls it. A convergence bench draws thousands of concurrent sessions and checks that copies converge, validate and lose no edit of a person without telling.
