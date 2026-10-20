---
name: elabora-narration
description: Generate or import course narration, work with speaker voices and paid ElevenLabs quota, align words and time visual events. Use for audio, scripts, timing or playback.
---

# Narration and timing in Elabora

Read course `AGENTS.md` first. Open the `voice-and-timing` reference **only when implementing complex voice, multi-speaker dialogue or word-level animation** (`elabora tools skills elabora-narration voice-and-timing`, or MCP `elabora://skills/elabora-narration/references/voice-and-timing`).

## Contract and operations
- The script lives in `screens/<id>.json` under `narration.lines` (id, speaker, text, step, pauseBefore), not embedded in an audio file. Define speakers in `course.json`. Use `elabora_timeline` to inspect timing.
- Select a voice with `elabora_voice_list` or `elabora_voice_search`, then `elabora_voice_set`. Generate with `elabora_voice_generate` or import a human recording with `elabora_import_narration`; never write narration audio/sidecars manually. Regenerate stale audio after changing text, delivery or pronunciation.
- **ElevenLabs quota policy:** estimate with `elabora_voice_estimate`. Express cost as a percentage of the **author's monthly quota**, not credits. **Below 1%**, generate without asking; **at or above 1%**, explain the estimated percentage and obtain the author's agreement before calling generation with `approvedPercent` / `--spend`. The tool refuses an unapproved larger spend; do not work around it. The same cost policy applies to optional paid transcription.
- Transcribe recordings locally by default. Use ElevenLabs transcription only when the author explicitly requests it (`service: "elevenlabs"`), applying the same quota policy.
- For narration-driven screens, use learner-controlled steps by default (about 90 seconds maximum per step). Anchor reveals and events to **line/word** ids, not seconds: they survive changed audio and translation. Align recorded/generated words with `elabora_align_narration`; examine warnings and `elabora_look --at` / `--sheet`. Non-narrated screens may use second-based timing.
- Avoid duplicating full narration in visible blocks: show supporting figures and keywords; captions/transcripts carry the spoken words. Keep interactive questions visible until answered. Never make an entire course advance automatically without author intent.

Validate the result, then preview the relevant moments and phone layout.
