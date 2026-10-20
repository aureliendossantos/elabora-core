---
npm/elabora: minor (Changed)
npm/@elabora/format: minor (Changed)
npm/@elabora/player: minor (Changed)
npm/@elabora/core: minor (Changed)
npm/@elabora/node: minor (Changed)
npm/@elabora/engine: minor (Changed)
npm/@elabora/cli: minor (Changed)
---

The learner's player is rebuilt on course.json player (D58): a top and a bottom bar, each an ordered list of items (logo, title, progress, outline, controls, resources, glossary, « IA et crédits », Previous, Next, Quit) that authors enable, move and configure, with player.* theme tokens checked for contrast. Bars with nothing to show are removed; unavailable Previous and Next stay in place, greyed, and say why in one shared tooltip; the seek bar's tooltip quotes the words said, with the speaker. New: Resources (files of assets/, a PDF previewed in the browser's own viewer with Download), a searchable Glossary that texts link to with [word](glossary:id), and « IA et crédits », which names generated voices and media (EU AI Act, art. 50) with the course's credits. New checks: W_PLAYER_NO_WAY_BACK, W_PLAYER_END_UNREACHABLE, W_PLAYER_AI_MENTION_HIDDEN, W_PLAYER_CONTROLS_HIDDEN, W_PLAYER_TRANSCRIPT_HIDDEN, W_PLAYER_EXIT_HIDDEN, I_PLAYER_SPEEDS_NONE, E_PLAYER_ITEM_DUPLICATE, E_GLOSSARY_TERM_UNKNOWN, E_DUPLICATE_ENTRY, W_RESOURCE_TYPE. One operation reads and changes it all: elabora player (MCP elabora_player, engine update_player). navigation.showMenu, showProgress and footer and the course's narration.seek none moved into player and are now E_PLAYER_SETTING_MOVED, with no migration before the first release.
