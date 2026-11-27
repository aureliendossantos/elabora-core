---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

The canvas relay serves the files it keeps with its own headers (the host's policy and isolation, the type the file's name says), not the headers found in its cache: an object's code on the frames host could store the right bytes there with headers that stopped every free object from showing.
