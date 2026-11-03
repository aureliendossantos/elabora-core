---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

The editor canvas reports where blocks come to rest after a theme brings them in moving (Editorial's masks, Paper's sheets laid down): the app's selection no longer stays where they began, 24 px too low in Editorial. A band, a text over its picture and a statement on an image go edge to edge even when a theme holds every block flush left to a column (`.t-block { max-width; justify-self: start }`): in Editorial and Clear they were drawn with no width, in the page's margin or not at all. The templates Editorial and Clear open and close the module with a fork of the opening without a picture or another presentation (`editorial-cover`, `clear-cover`): a band or an image would cross the plates or the accent panel. Their bands' text starts where their page does.
