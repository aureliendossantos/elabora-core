---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

Screen readers hear a part opener's number: the seven module templates read it « Part 1 » (« Partie 1 »…) with the player's new label `part` (`data-t-label="part"`, in every language of the player), just before the title where the number stands before it, and Editorial's number moves before the title in the page (on phones it still shows above it). A figure that holds nothing screen readers read (a decorative picture without a caption) is no longer exposed as an empty figure (`role="none"`); a zoom button in it stays. `elabora fit` no longer measures letters painted by a gradient clipped to them (`background-clip: text`) against themselves, which reported them unreadable whatever their colours.
