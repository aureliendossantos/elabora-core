---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

`ProtocolClient.close()`: when the connection to the engine goes (a module closed, the engine stopped), every request still waiting is rejected as `closed`, later requests at once, and an answer that comes after is ignored. A transport that cannot send any more rejects the request rather than leaving it waiting.

A session closing (the author back home, another module opened) stops its voice jobs first: the lines said so far stay, and a line being said is no longer paid for and lost when its write meets the closed session. The close version is still taken.
