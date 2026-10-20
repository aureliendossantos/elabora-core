---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

A PDF resource's preview showed an empty frame in the editor canvas, the preview and the LMS emulator: the local servers sent PDFs as application/octet-stream, which browsers download. They now send PDFs, office documents, ZIP and RTF with their types, and the player shows the file's card (with Télécharger and Ouvrir dans un nouvel onglet) when a server would still make the PDF a download. The editor canvas no longer takes the focus from its host when it renders, is pushed a change or is asked to open something; it moves the focus only once the author works in it. A learner who switches language keeps their text size, captions, volume and speed.
