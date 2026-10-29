---
name: elabora
description: Work on an Elabora e-learning module (a folder with course.json and AGENTS.md) - its plan, screens, design, quizzes, dialogues, narration, translation, checks and SCORM package - through the tools of the Elabora installed on this computer. Use when the user mentions Elabora or an Elabora module or course, or the folder holds course.json.
---

# Elabora

This plugin carries no copy of Elabora's guidance: it connects the `elabora` command installed on this computer, whose MCP server serves the rules, skills and documentation of the author's own Elabora version.

1. **Read the course's `AGENTS.md`** and its author notes before anything else. They are the rules, and they map each task to the Elabora skill to load.
2. **Use the `elabora` MCP server** this plugin starts in the session's folder (tools named `elabora_*`). Load skills only as `AGENTS.md` says: the resources `elabora://skills/<name>`, or `elabora_docs { page: "skills/<name>" }`.
3. **The session's folder is not a course?** The server says so in its instructions and offers only the documentation and `elabora_projects_list`, which gives the author's modules and their folders. Ask the author to start the session in the module's folder; meanwhile, from a shell, `elabora tools call <tool> <folder> --args '<json>'` runs any operation on a module. A folder of several modules is served whole: each operation then takes `course`.
4. **No `elabora_*` tools at all?** The server could not start: `elabora` is probably not on the PATH (`elabora --version` tells). On a Mac, the author installs it in Elabora's settings, Tools for AI (Réglages › Outils pour les IA in French); on Windows, the installer adds it, and a new terminal sees it. Until then, call the app's copy by its path, as `AGENTS.md` gives it: `/Applications/Elabora.app/Contents/Resources/bin/elabora` (macOS) or `%LOCALAPPDATA%\Programs\elabora\resources\bin\elabora.cmd` (Windows), with `elabora tools list` and `elabora tools call`. Once it is installed, a new session connects the server.

Never change the author's agent configuration yourself, and leave to the author what `AGENTS.md` says is theirs (plan versions and approvals, publishing, paid voices beyond their approval).
