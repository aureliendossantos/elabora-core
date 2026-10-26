---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

Importing several media files one after the other no longer fails now and then with "The project lock is held by another task of this process": an import waits for the lock instead of refusing it (a gallery could lose a picture when its files were added together).
