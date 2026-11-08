---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

`ProtocolClient.close()`: when the connection to the engine goes (a module closed, the engine stopped), every request still waiting is rejected as `closed`, later requests at once, and an answer that comes after is ignored. A transport that cannot send any more rejects the request rather than leaving it waiting.
