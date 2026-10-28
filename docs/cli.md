# Command line

Generated from the help of `elabora` by `pnpm run docs`: `elabora help` prints the same, and `elabora <command> --help` one group. `[dir]` is a course folder (the current one by default). Run it from a checkout with `node bin/elabora.js`, or through the desktop app's bundled command.

## Project

```text
init <dir> --id <id> --title <title> [--lang fr]   Scaffold a course project (course.json, plan.json, AGENTS.md)
     [--audience <who>] [--business-goal <goal>]    What the author already said of it: the plan's audience, business goal and
     [--duration 10-20|5|30+] [--presentation        duration in minutes, the presentation, the LMS, and notes for agents in
     slides|scroll] [--lms a,b] [--notes <text>]    AGENTS.md (the tone, the brand wanted, what is left to the agent)
validate [dir] [--profile a,b] [--release] [--json] Check format, plan conformity, pedagogy, accessibility, budgets
project [dir] [--client] [--screen <id>]            Markdown view of the course (agent map, or client review)
migrate [dir] [--dry-run] [--json]                  Write the course in the current format (older ones are read migrated): one
                                                    change after a backup version, undone by elabora undo
rename [dir] <old-id> <new-id> [--json]             Rename a section, screen, layer, block or event: its references, the
                                                    screen file and the state lock follow (learner progress keeps its key)
ignore [dir] <code> <key> [--restore] [--json]      When the author asks: ignore a warning that has a key (elabora validate
                                                    prints it), as « Ignorer » in the editor does (course.json ignored,
                                                    D31); it comes back when what it found changes. --restore: back
```

## Projects (the app's library: one plain folder per project; archives to exchange them)

```text
projects list [--json] [--validate]                 Projects of the library, newest first: title, course, date, size,
                                                    validation, folder (--validate checks those not checked yet)
projects path [<id>] [--set <dir> [--move|--copy]]  Folder of the library, or of a project (id or its first characters).
                                                    --set: use another folder; --move takes the projects along; --copy
                                                    moves them by copying and checking every file (another disk)
projects create <course-id> --title <t> [--language fr]
                                                    Create a course in the library
projects duplicate <id> [--title <t>]               Copy a project under a new id (same course id; the history stays)
projects rename <id> --title <t>                    Change the title of a project (an undoable edit of course.json)
projects trash <id>                                 Move a project, history included, to the library's trash
projects trash list|restore <entry>|empty [--older-than <days>]
                                                    What the trash holds; put a project back; delete for good
export [dir] [--out <file>] [--history] [--sources] [--json]
                                                    Write a project archive (default dist/<course-id>.elabora): the
                                                    project's files and, with --history, its journal and backups; with
                                                    --sources, the author's sources (sources/, may hold personal data)
import <archive|folder> [--replace [<id>] | --copy] [--json]
                                                    Import into the library: an archive (every file checked) or a folder
                                                    (copied). When the library holds the course already, say --replace
                                                    (the replaced files go to the trash, the history stays) or --copy
import <file> [dir] [--title <t>] [--id <id>] [--lang fr] [--choose <decision>=<choice>,…] [--json]
                                                    Beta: a Storyline 360 project (.story), a course Storyline published
                                                    (folder or zip, web or LMS) or a Rise 360 export, as a new module: in
                                                    dir, or else the library. Writes import-report.json (every loss, the
                                                    choices to make); --choose takes one of its choices: presentation=scroll,
                                                    backgrounds=keep, timing=steps, fonts=theme, media-accessibility=errors
```

## History (changes made through Elabora tools and by agents; AI work is grouped in batches)

```text
history [dir] [--limit 20] [--json]                 Changes grouped by batch of AI work: when, who, the request, what
                                                    changed, what was undone
undo [dir]                                          Undo the last change made through Elabora tools or by an agent
undo [dir] --change <id|seq>                        Undo one change (an undo too: that redoes it)
undo [dir] --batch [<id>]                           Undo a batch of AI work (default: the last one). Whatever changed
                                                    since is kept, and listed
mark [dir] "<request>"                              Label the next batch of AI work with the request that starts it.
                                                    Claude Code: a UserPromptSubmit hook running elabora mark --stdin
                                                    labels each batch with the prompt (read from the hook's JSON)
```

## The author's sources (never published)

```text
sources list [dir] [--json]                         The author's sources (sources/: a brief, a deck, recordings; never
                                                    published), each with its readable version: ready, partial (its
                                                    transcript to come), stale, missing, failed, native (read as it
                                                    is: images, text, a PDF) or unsupported
sources add [dir] <file|folder>… [--no-read] [--json]
                                                    Copies files into sources/ (a file already there is not copied
                                                    again, a name taken is numbered, one Windows refuses is made
                                                    portable), then writes their readable versions (--no-read: later)
sources read [dir] <file> [--no-refresh] [--json]   A source's readable version (Markdown), written first when it is
                                                    missing or out of date: a Word document with its comments and
                                                    tracked changes, a deck's slides in reading order with their notes
                                                    and pictures, a recording's transcript (heard on this computer, the
                                                    model downloaded once, 671 MB); an image or a PDF: its path
sources refresh [dir] [<file>…] [--force] [--json]  Writes the readable versions missing, out of date or waiting for a
                                                    transcript; --force writes them all again
sources remove [dir] <file> [--json]                Deletes a source and its readable version for good: no backup
                                                    holds sources

Nothing leaves the computer: a client's brief may hold personal data. A deck gives its slides' texts, notes
and pictures (the slides themselves are not drawn: add the deck as a PDF too to see them); a file in an older
office format (.doc, .rtf, .odt, .ppt, .odp, .key) is read once saved as .docx or .pptx; agents read PDFs themselves.
```

## Media (video, audio and images of assets/)

```text
media import [dir] <file…> [--to <folder>] [--name <name>] [--no-wait] [--json]
                                                    Bring media into assets/ (video, audio, images): converted in the
                                                    background to web masters (MP4 H.264/AAC, M4A, WebP; SVG as is),
                                                    metadata such as GPS positions removed, the original never copied.
                                                    Prints the paths at once, then waits (--no-wait: a worker goes on)
media optimize [dir] [<path>…|--all] [--json]       Convert media of assets/ that are not masters (W_MEDIA_NOT_OPTIMIZED);
                                                    references follow a new extension, in one undoable change
media captions [dir] <block> <file.vtt|.srt> [--name <name>] [--json]
                                                    Captions of a video block (E_VIDEO_CAPTIONS_MISSING): the file written
                                                    under assets/captions/ (SubRip converted to WebVTT), named by the
                                                    block, in one undoable change
media status [dir] [--wait] [--json]                Media jobs (queued, running, done, failed) and media to optimise
media cancel [dir] <job>                            Cancel a media job
media worker [dir]                                  Run the project's media jobs until none is left (import --no-wait)
```

## Narration (the voice of narrated screens, and their timeline)

```text
timeline [dir] [screen] [--language <lang>] [--json]
                                                    A timed screen's timeline as text: its steps and their times,
                                                    each line with its speaker, start, end and audio (ok, missing,
                                                    stale), the blocks of each step, the timed blocks with their
                                                    moments and effects, and the events its cues fire; then each
                                                    layer that has its own timeline. Without a screen: every
                                                    narrated screen and its audio
timing [dir] <block> [--in <moment>] [--out <moment>] [--effect <name>] [--duration <s>] [--direction <side>]
       [--out-effect <name>] [--out-duration <s>] [--out-direction <side>] [--clear in|out|all] [--json]
                                                    When a block comes and goes on its screen's timeline, in one
                                                    undoable change. A moment: l2 (a line starts), l2:end, a word of
                                                    it l2:imprimante (l2:imprimante:end, #2 its second time, +0.3s
                                                    after it), 1.5s or 1.5s@2 from a step's start on a screen without
                                                    narration, step2, step2:end. Effects: none, fade, rise, slide,
                                                    zoom, wipe, draw, or the theme's; sides: left, right, up, down
narration import [dir] <screen> <line> <file> [--language <lang>] [--keep-silence] [--json]
                                                    A recorded human voice for a line: converted (M4A, AAC, mono), its
                                                    silence at both ends trimmed, written to
                                                    assets/narration/<language>/<screen>/<line>.m4a with its sidecar,
                                                    in one undoable change (W_NARRATION_AUDIO_MISSING, _STALE)
narration import-files [dir] [--screen <id>] <file>… [--language <lang>] [--keep-silence] [--json]
                                                    Recordings of several lines at once: each file goes to the line its name
                                                    gives (l2.wav, accueil-l2.m4a, or 02.wav: the second line of --screen),
                                                    the others to the line of --screen whose text the voice says (with the
                                                    word aligner installed); one undoable change a line
narration from-plan [dir] <screen> [--replace] [--json]
                                                    The screen's script from the voice-over the validated plan gives the items
                                                    it covers (plan items' voiceover), a line each; --replace: a screen that
                                                    has a narration loses it and its audio
narration transcribe [dir] <file> [--language <lang>] [--service local|elevenlabs] [--spend <percent>] [--json]
                                                    What a recording says, punctuated, its words with their times: on this
                                                    computer by default (Parakeet, downloaded once, 671 MB; free, nothing
                                                    leaves the computer), or by ElevenLabs with the author's key: from 1 %
                                                    of the quota it says the share (exit code 3) and runs with --spend
narration add-from-audio [dir] <screen> <file> [--text <text>] [--after <line>|--first] [--step <n>] [--speaker <id>] [--layer <id>]
       [--language <lang>] [--keep-silence] [--service local|elevenlabs] [--spend <percent>] [--json]
                                                    A new line made from a recording: its text what the recording says
                                                    (transcribed, or --text), its audio the recording (trimmed, encoded),
                                                    its words timed when the aligner is installed, in one undoable change;
                                                    after the last line by default, in the step and with the speaker of
                                                    the line before it; --layer: a line of that layer's narration
narration retranscribe [dir] <screen> <line> [--dry-run] [--text <text>] [--service local|elevenlabs] [--spend <percent>] [--json]
                                                    The line's text written again from its recording (a recording says
                                                    something else than the script): its old and new text printed, then
                                                    written in one undoable change, the recording kept and its words timed
                                                    again; translations of the line become « changed since ». --dry-run:
                                                    print only
narration keep [dir] <screen> <line> [--language <lang>] [--json]
                                                    The line's text was corrected (a checked transcription, a typo) and its
                                                    audio still says it: the audio stays up to date, its words follow
narration split [dir] <screen> <line> [--json]       Cut a step at a line (W_SEGMENT_TOO_LONG): the line and those after it in
                                                    its step start the next step, so Continue paces them; later steps, their
                                                    blocks and the anchors that name them move one on, in one undoable change
narration align [dir] [screen] [--line <ids>] [--language <lang>] [--force] [--json]
                                                    When each word of the voiced lines is said (forced alignment):
                                                    written into their sidecars, where word anchors find their
                                                    times. Downloads the word aligner of the language once (French
                                                    355 MB, English 95 MB); lines made or imported afterwards are
                                                    timed at once. --line l1,l2 (with a screen); --force: lines
                                                    already timed too. Says which words the voice may have swallowed
```

## Voices (generated narration)

```text
voice list [--language <lang>] [--json]           The voices a narration line can be generated with: id, name, register
                                                    and pace, licence of the recording it comes from, and whether its
                                                    model is on this computer (else the size downloaded on first use)
voice models [--language <lang>] [--json]           The local voices by language and their model: on this computer (its
                                                    size on disk) or not (the size downloaded on first use), being
                                                    downloaded now (by the app, a command or an agent) or in use (the
                                                    voices' part of elabora downloads list)
voice install <language> [--force] [--json]         Downloads the model of a language's local voices once for this
                                                    computer (fr 354 MB, en 126 MB), with its progress; --force removes
                                                    it first and downloads it again (a reinstall)
voice uninstall <language> [--json]                 Removes the model of a language's local voices from this computer
                                                    (elabora downloads uninstall voices-<language>), refused while lines are
                                                    said with it or it is being downloaded; the lines already made keep
                                                    their audio, and the next generation downloads it again
voice set [dir] <speaker> <voice> [--language <lang>] [--provider elevenlabs] [--name <n>] [--model <id>]
          [--stability <0-1>] [--similarity <0-1>] [--json]
                                                    The voice of a speaker of course.json in a language
                                                    (speakers[].voices[<lang>]): its lines made with another voice are
                                                    then out of date
voice generate [dir] <screen> [--line <id,…>] [--all] [--voice <id>] [--language <lang>] [--take <n>]
               [--dialogue] [--spend <percent>] [--json]
                                                    Generates the lines of a narrated screen with their speaker's voice
                                                    (by default those missing or out of date; --all: every line):
                                                    each a new take, written to assets/narration/<lang>/<screen>/ with
                                                    its sidecar (generated voice, credit), one undoable change a line.
                                                    --voice sets that voice for the speaker of the lines first;
                                                    --take puts back an earlier take of one line
voice takes [dir] <screen> <line> [--language <lang>] [--json]
                                                    The takes of a line kept on this computer: which one is its audio,
                                                    which can be put back (--take)
voice search [words] [--language <lang>] [--gender female|male] [--age young|middle_aged|old] [--accent <a>]
             [--use-case <u>] [--mine|--library] [--model <m>] [--high-quality] [--ready] [--page <n>] [--json]
                                                    ElevenLabs voices (D29): the account's own, then the library's
                                                    thousands, most used first; each with its accent, age, use, a
                                                    recording to hear it (free), its price over the model's, its
                                                    quality and whether it is ready for the model (Eleven v4 unless
                                                    --model) in the language: prefer « checked in <lang> ».
                                                    --high-quality: professional clones that passed ElevenLabs'
                                                    check only; --ready: those checked with the model in the language
voice estimate [dir] <screen> [--line <id,…>] [--all] [--dialogue] [--language <lang>] [--json]
                                                    What generating would cost before anything is spent: the share of
                                                    the monthly quota, characters and credits per line (about, at most),
                                                    lines made free (local voices, earlier takes given back), the runs
                                                    said as one exchange (--dialogue)
voice account [--check] [--json]                    The ElevenLabs plan, the share of its monthly quota used, what a line
                                                    costs of it, the key (masked) and where it comes from; --check tries
                                                    each permission Elabora needs without spending
voice key set|remove|status                         The ElevenLabs API key for the command line and agents: set reads
                                                    it from the input (never an argument), keeps it readable by you
                                                    only in Elabora's local data; ELEVENLABS_API_KEY overrides it

A paid voice's cost is told as a share of the author's monthly quota (D30). Under 1 % of it, voice generate
runs; from 1 %, it refuses with the estimate (exit code 3) and runs with --spend <percent> once the author
agreed to that share. --dialogue says the lines of several speakers that follow each other in a step as one
exchange, cut back into lines (their pauses from it). Stage directions in brackets ([chuchote], [rit]) are
played by Eleven v4 voices and never shown.
```

## Dialogues (branching conversations held in a block)

```text
dialogue show [dir] <block> [--json]                A dialogue block as a script: each node with its lines (name, stage
                                                    direction, line), its options with their quality, points, effects and
                                                    « then … » (where each one goes), their reply and feedback, then the
                                                    endings. Stable text: it also serves diffs
dialogue play [dir] <block> [--choose b,a,a] [--json]
                                                    « Jouer un chemin »: the path of these choices (option ids, one for each
                                                    decision met, retries included), its lines and notes, the ending, the
                                                    score, the decisions and the duration (the lines' audio, else estimated
                                                    from the text). Exit code 1 when a choice is not offered (it says which
                                                    were)
dialogue paths [dir] <block> [--limit <n>] [--json]
                                                    Every path: how many, the best and worst score and points, the endings
                                                    reached and never reached, the nodes never reached, and each path with
                                                    its choices, ending, score and duration (2000 paths at most)
dialogue export [dir] <block> --to html|pdf [--out <file>] [--date YYYY-MM-DD] [--json]
                                                    The dialogue for the client: its map (every node and ending, placed by
                                                    Elabora), then its script, as one page (html) or printed (pdf, by
                                                    Elabora's or Google Chrome's Chromium); dist/<course>-<block>.<format>
                                                    by default
```

## Optional downloads (models downloaded once per computer)

```text
downloads list [--kind <kind>] [--language <lang>] [--json]
                                                    What Elabora downloads once per computer on first use (never in a
                                                    course): the local voices and the word aligners, by language, what
                                                    each is for and what happens without it, on this computer (its size
                                                    on disk) or not (the size to download), being downloaded now (by
                                                    the app, a command or an agent) or in use
downloads install <id> [--force] [--json]           Downloads one now (voices-fr, aligner-en…), with its progress; --force
                                                    removes it first and downloads it again (a reinstall)
downloads uninstall <id> [--json]                   Removes one from this computer, refused while it is in use (lines
                                                    said, words placed) or being downloaded; what modules already
                                                    contain stays, and the next use downloads it again

elabora voice models, voice install and voice uninstall are the local voices' part of these (voice uninstall <lang>
is downloads uninstall voices-<lang>).
```

## Build and test

```text
build [dir] [--profile a,b|all] [--release] [--out <dir>] [--dir] [--debug] [--media-quality high|medium|low] [--languages all] [--no-wait] [--json]
      [--target scorm12|web] [--progress local|none] [--navigation authored|free] [--noindex] [--url <address>] [--image <file>]
      [--review-origin <origin>]…
                                                    Validate, then compile a deterministic SCORM 1.2 package + proof dossier.
                                                    Media ship at delivery.mediaQuality (default high: the masters); lower
                                                    qualities ship renditions, encoded once and cached. Waits for media
                                                    jobs (--no-wait: refuses while they run).
                                                    --languages all: one package of every language, the course's own
                                                    and each translation that is ready and approved; learners switch
                                                    from the player's « Langue » and keep their progress (D59).
                                                    --target web: a module for a plain web server, no LMS (a folder to serve
                                                    and its ZIP, <course>-<version>-web). --progress local (default: kept in
                                                    the browser, resumed at the next visit) or none (nothing kept);
                                                    --navigation authored (default: the course's rules) or free (every screen
                                                    open, no lock); --noindex keeps search engines out; --url: the address
                                                    of its index.html (canonical, sharing previews); --image: a PNG, JPEG or
                                                    WebP shown when the link is shared. A showcase: --progress none
                                                    --navigation free; a publication: the defaults.
                                                    --review-origin (repeatable): a module for the Revue, shown in an
                                                    iframe by a page of that origin (https://revue.elabora.studio; http
                                                    on localhost for development): it carries the review bridge
                                                    (elabora-review/1, docs/review-bridge.md) and talks to that page
                                                    only; progress none, navigation free and noindex by default
test [dir] [--package <zip>] [--profile a,b|all] [--mode iframe,popup…] [--browser chromium,electron,chrome,msedge,playwright,firefox,webkit] [--parallel 4] [--no-a11y] [--json]
                                                    Run the package in the LMS emulator (profiles × launch modes × browsers);
                                                    4 runs side by side by default, fewer on a loaded machine
preview [dir] [--port 4807] [--profile <id>]        Live preview (standalone and in the LMS emulator): pages reload after each
                                                    rebuild; free objects show in the in-app browsers of agent apps
look [dir] [--screen <id>,…|all] [--size 1600x900,375x812] [--state initial|answered] [--step <n>] [--layer <id>]
     [--at <moment> | --sheet] [--scroll <px|N%|block>,…] [--block <id> [--scale 2] [--act <action>]…] [--viewport] [--motion]
     [--language <code>] [--out shot.jpg | --out-dir <dir>] [--json] | --url | --stop
                                                    See a screen while designing, in well under a second: a look server kept warm
                                                    for the course (one browser, no build) renders it from the files as they are,
                                                    with the player's header and footer; free objects an edit did not touch keep
                                                    running. JPEG (PNG: --out x.png), in .elabora/look/ by default. Says whether a
                                                    slide fits. --url: a page that follows the looks and the files, for a browser
                                                    pane. --stop: stop the server (it stops itself after 15 minutes without a look).
                                                    --at: a timed screen at a moment, the window with its bar: l2 (a line starts,
                                                    its caption shown), l2:end, l2:imprimante (a word), l2:imprimante+0.3s,
                                                    1.5s@2, step2:end, 12.5 (seconds). --sheet: a contact sheet, one capture per
                                                    mark of its timeline (start, each block that comes or goes, each cue, each
                                                    step's end), captioned with the anchor and what happens; on a screen without a
                                                    timeline, the page down its length (0, 25, 50, 75, 100 % or --scroll's). With
                                                    --layer, a layer that has its own timeline: --at and --sheet are on it.
                                                    --scroll: the window there, animations on (px, % of the page, or a block's id);
                                                    several: a sheet down the page. --block: a close-up of the block (PNG up to 2
                                                    Mpx, else JPEG; in view unless --scroll says where), --scale 2 drawn twice as
                                                    large. With --scroll, --block or --motion it says what moves: each block in
                                                    the window (or the block) visible, clipped or outside, its animations and
                                                    transitions, their timeline and progress, and the scroll-driven ones that
                                                    CANNOT FINISH (the page ends before their range). --act (repeatable) drives
                                                    the free object of --block from inside its frame before the capture:
                                                    click:<text>, click:role=<role>[name=<n>], key:<key>, drag:x,y->x,y (0-1 across
                                                    the object); it reports the object's state and events, and the object keeps
                                                    that state until the screen changes. On a dialogue block, choose:<option>
                                                    (one per decision met, retries included, as dialogue play) shows its thread
                                                    at rest after those choices, its end in the window: notes, the next options,
                                                    or the debrief
screenshot [dir] [--screen <id>,…|all] [--size 1600x900,375x812] [--state initial,answered] [--step <n>] [--layer <id>]
           [--at 0,2000,4000|l1,l2:end | --scroll 0,25%,50%,1800] [--motion] [--viewport] [--out shot.png | --out-dir <dir>]
                                                    Render screens to PNG once images and free objects are ready. answered: every
                                                    activity shows its tallest feedback. --at: filmstrip of the animations (ms),
                                                    or of a narrated screen as each line starts (l2) or ends (l2:end), with
                                                    --layer of that layer's own timeline;
                                                    --scroll: filmstrip down the page (px or % of it: scroll-driven animations and
                                                    objects). One contact sheet. Several shots share one build and one browser;
                                                    --out names one image, so several shots are refused with it (exit code 2):
                                                    --out-dir gets one file each
fit [dir] [--screen <id>,…] [--reference 1600x900] [--minimum 1280x720] [--phone 375x812|none] [--language <code> [--allow-missing]] [--fresh] [--json]
                                                    Measure every slide (all steps shown) at the fit sizes: what scrolls, by how
                                                    much, and what moves once its activities are answered. In scroll presentation:
                                                    the length of each page and the contrast of its text, down the whole page.
                                                    On a phone (375×812 unless sizes are given): the contrast of the text down
                                                    the page and the player's bars that go onto two lines. --language: the
                                                    translation (--allow-missing: a draft, missing texts in the source language).
                                                    A screen unchanged since its last measure (its files, the theme, components,
                                                    objects, Elabora, the browser) is not measured again: its fit is reused
                                                    (--fresh measures every screen again)
inspect <package.zip>                               Read any SCORM package: manifest, files, size
diff <old.report.json> <new.report.json> [--profile a,b]
                                                    What an update does to learners in progress, LMS by LMS
profiles [--json]                                   List executable LMS profiles
```

## Hosting: account (elabora.studio)

```text
account login --email <address> [--device <name>] [--language fr|en] [--handle <name>] [--json]
                                                    Signs in to Elabora's hosting: a code is sent to the address and
                                                    read from the input (never an argument); the session is kept
                                                    readable by you only in Elabora's local data. At the first sign-in,
                                                    --handle (or the input) chooses the account's address, once.
                                                    The device is named « Elabora CLI · macOS » (or Windows, Linux),
                                                    never after your computer; --device names it as you like
account login --invitation <file>|- --space <space> [--json]
                                                    Keeps a tester's invitation key instead (from a file, or the input
                                                    with -), after checking it opens its space
account handle <name> [--json]                      Chooses the account's address once: https://<name>.elabora.page/
account status [--json]                             Who is signed in (the token masked, where it is kept), the space,
                                                    the account's limits and usage
account logout [--json]                             Ends the session on the server and forgets it here (an invitation
                                                    key or an AI key is only forgotten)
account ai-key create [--name <name>] [--replace-session] [--json]
                                                    Makes a read-only key for your AI with your session and keeps it
                                                    readable by you only: it lists reviews and reads their comments,
                                                    nothing else (agents' read tools take it first). --replace-session:
                                                    forget the session file then, so that what agents can reach here
                                                    only reads (sign in again to publish or answer)
account ai-key list [--json]                        The account's AI keys (never a key), the one kept here marked
account ai-key revoke <aik_…> [--json]              Revokes an AI key at once (and forgets it here if kept)
```

## Hosting: publishing and review

```text
publish [dir] [--private] [--name <publication>] [--image <file>] [--index] [--progress local|none]
        [--navigation authored|free] [--languages all] [--review-origin <origin>] [--json]
                                                    Builds the course for the web and publishes it in your space; only
                                                    the files the space lacks are sent (a second publication of the
                                                    same content sends nothing). Public: https://<space>.elabora.page/
                                                    <name>/ (default name: the course id), noindex unless --index.
                                                    --private: a review build (<id>-review by default) that only a
                                                    review shows; a new version goes to its open reviews, even with
                                                    red checks (listed: they stop the web, not reviewers).
                                                    --languages all: one package of every approved language, which
                                                    learners switch in the player (D59; public only). A folder
                                                    elabora build --target web wrote is published as it is
publication versions <publication> [--json]         The versions the hosting keeps of a publication (the current one
                                                    marked): older ones stay at their pinned addresses
publication withdraw <publication> <version> --yes [--json]
                                                    Takes one older version down for good while the publication goes
                                                    on: its pinned address answers 404, a review that showed it lists
                                                    it as withdrawn (its comments stay), the files only it used are
                                                    deleted. The current version is refused: publish a newer one first
review create [dir] [--name <publication>] [--version <v>] [--title <t>] [--note <text>] [--link-out <file>]
              [--json]                              Shares a private publication for review: prints the reviewers'
                                                    link once (or writes it to --link-out, readable by you only).
                                                    --note: a word to reviewers, under « <your name> vous invite à
                                                    relire ce module » on the review page (500 characters)
review list [dir] [--all] [--json]                  The course's reviews (--all: the space's): state, versions, open
                                                    and resolved comments, reviewers
review link <review> [--link-out <file>] [--json]   A new link for reviewers: the old one stops at once
review close <review> [--read-only] [--json]        Closes a review (nothing shown any more), or makes it read-only
review open <review> [--json]                       Opens a closed or read-only review again, under the same link
review delete <review> --yes [--json]               Deletes a review, its comments and reviewers, and its private
                                                    publication when no other review shows it
review comments [dir] [--review <review>] [--since <rev>] [--state open|resolved] [--screen <id>] [--json]
                                                    The reviewers' comments placed in the course: the screen (key,
                                                    title, source file), the block (id, type, pointer), the step,
                                                    layer, narration line and word, the version commented and whether
                                                    a newer one or the screen's source changed since, the author, the
                                                    text, the state and the replies. --since <rev>: only what changed
review reply <review> <comment> [text] [--name <n>] [--json]
                                                    Answers a thread (#4 or cm_…) as the author (the text, or the
                                                    input); --name: the name shown (default: the account's)
review resolve <review> <comment> [--json]          Marks a thread resolved
review reopen <review> <comment> [--json]           Opens a resolved thread again

The API is https://api.elabora.studio (ELABORA_CLOUD_URL elsewhere). A tester's key in a file also serves
with ELABORA_CLOUD_KEY_FILE and ELABORA_CLOUD_SPACE.
```

## Design

```text
assets [dir] [--only <name>] [--sheet <file.png>]   Run generators/*.mjs: regenerate figures from code, theme tokens and plan.
                                                    --sheet: a contact sheet of what they wrote, on the course's surface colour
theme upgrade [dir] [--dry-run] [--json]            Put the theme's rules under the components (theme.cascade
                                                    components-over-theme, D32), the course's look kept: what the theme
                                                    sets on properties components also set goes into @layer overrides.
                                                    One undoable change
player [dir] [--enable <items>] [--disable <items>] [--move <item:bar[:index]>] [--set <item.option=value>]
       [--position <bar=window|page>] [--token <player.name=value>] [--logo <asset|none>] [--reset]
       [--link-terms [<ids>]] [--add-resource <file>…] [--title <t>] [--description <d>]
       [--target scorm12|web] [--json]
                                                    The learner's player (D58): its two bars of items (logo, title, progress,
                                                    spacer, outline, controls, resources, glossary, credits, display,
                                                    language, previous, next, exit), what shows and why not, its tokens and
                                                    findings. With changes: one undoable change. The spacer is one per bar,
                                                    always on: --move spacer:top:3 says where the start of the line ends.
                                                    --set controls.speeds=0.75-1.5, outline.screenTitle=true,
                                                    controls.transcript=false, logo.plate=true, glossary.linkTerms=false;
                                                    --token player.top.background=#FFFFFF (=default removes it).
                                                    --link-terms links the glossary's terms (all, or the ids given) the
                                                    first time each is in each screen. --add-resource copies any file into
                                                    assets/resources/ and adds it to the resources, titled by --title,
                                                    else the PDF's own title, else its name (one undoable change each).
                                                    Resources, glossary, credits: elabora tools call elabora_player .
                                                    --from <arguments.json>
```

## Fonts

```text
font list [dir] [--category <c>] [--json]           The vetted fonts shipped with Elabora (offline): family, category,
                                                    weights, styles, size, licence; ✔ marks those of the course
font add [dir] <family> [--weights 400,700] [--styles normal,italic] [--for body,heading] [--subsets latin,latin-ext]
                                                    Copy a vetted font and its licence into theme/fonts/<id>/, declare its
                                                    faces in course.json and give its stack to tokens (--for body,
                                                    heading, mono, display… or none; default: what the list says);
                                                    latin, and latin-ext when a language of the course needs it
font add [dir] --from <Fontsource package folder or .tgz> [--family <name>] [--weights …] [--styles …] [--subsets …] [--for …]
font add [dir] --file <a.woff2,b.woff2> --license <OFL.txt> [--family <name>] [--for …]
                                                    Any other font, with its licence: npm pack @fontsource-variable/<id>,
                                                    or WOFF2 files (weights and style read from the files)
```

## Components

```text
component list [dir]                                Block types of the course: built-in and components/<id>/
component new [dir] <id> [--title <t>] [--level block|screen]
component fork [dir] <parent> <id> [--title <t>]    Fork a component (built-in or course); the fork remembers its parent
component preview [dir] <id> [--width 375] [--out file.png]   Specimen of its examples, rendered
component migrate [dir] [<id>] [--from <version>]   Run migrations.mjs steps on every instance (all or nothing)
component add [dir] <id> --library <dir> [--as <id>] [--upgrade] [--force]   Copy (or upgrade) a library component
component publish [dir] <id> --library <dir>        Copy a course component into a library
block duplicate [dir] <block> [--id <new id>]       Copy a block (and the blocks of its slots)
block detach [dir] <block>                          Replace a component instance by its native fallback
block continue [dir] <block> --from <block> | --cut [--duration <ms>]
                                                    Continuity between screens (D65): the block carries on from a block of
                                                    another screen (a free object keeps running, another block glides), or
                                                    no longer does; --duration: the passage to it (default 700)
convert [dir] <screen> <block> --to <type>[:<presentation>] [--dry-run] [--lang fr] [--json]
                                                    « Transformer en… »: the block as another type or presentation, its id,
                                                    items and translations kept; without --to, the possible targets
```

## Free objects

```text
object new [dir] <id> [--title <t>] [--objectives OBJ-1,OBJ-2]
object test [dir] <id> [--update-snapshots] [--browser chromium|electron|chrome|msedge|playwright|firefox|webkit] [--only <test name>] [--force]
                                                    Gates 2–6 of the free-object contract (result kept in object.gates.json);
                                                    an object unchanged since its last run here is not run again (--force runs it)
object replay [dir] <id> [--test <name>] [--block <id>] [--size 1600x900] [--out sheet.png] [--json]
                                                    Replay a test of object.tests.json in the built course, on the page that
                                                    places the object, in real time: a contact sheet of its snapshot steps,
                                                    and its expectations checked
```

## Contract (the plan and its versions)

```text
plan status [dir] [--json]                          The plan's versions (made, sent, validated) and what changed since
plan write [dir] (--from <plan.json> | --patch <patch.json>)
                                                    Write the plan at any time (the whole plan, or a JSON Patch of it), its
                                                    schema checked first; items moved take their screens along. Agents never
                                                    change a text kept « à l'identique » (verbatim)
plan text [dir] <TXT-1|block> --text <wording>      Reword a validated text of the plan (by its id, or a block that shows it)
plan voiceover [dir] <item> (--from <file.txt> | --clear)
                                                    The voice-over of an item, one line per line of the file (« marc: Bonjour… »
                                                    for a speaker); elabora narration from-plan makes it a screen's script
plan diff [dir] [--from <Vn|validated|latest>] [--to <Vn|current>] [--json]
                                                    What changed in the plan, element by element (by default since the
                                                    validated version, to the working copy)
plan revert [dir] <key> [--version <Vn>]            Undo one change of the diff (item:ITEM-3, text:TXT-2…): back to the
                                                    validated version (or the one given)
plan note [dir] <key> (--text <note> | --clear)     A note for the client on a change in no version yet: frozen with the next
                                                    version, a comment in Word
plan version [dir] [--note <text>]                  A person's: freeze the working copy as the next version (V1, V2…)
plan approve [dir] [--version <Vn>] --by "<name, organisation>" [--reference <ref>] [--date YYYY-MM-DD]
                                                    A person's: the client validated a version (the latest by default)
plan export [dir] [--version <Vn|current>] [--format pdf|docx|html] [--out <file>] [--date YYYY-MM-DD] [--json]
                                                    The plan's document, what the client reads, comments and signs: the
                                                    latest version (the working copy without one), its changes since the
                                                    validated version as tracked changes in Word; PDF (default; printed by
                                                    Elabora's or Google Chrome's Chromium), Word or one HTML page, in
                                                    dist/<course>-plan.<format> by default. Records the send on the
                                                    version; never makes one
```

## Translation (one package per language; translations live in the source course, translations/&lt;lang&gt;.xlf)

```text
translate export [dir] --to <lang>                  Create or update the XLIFF 2.0 file: every string, what changed since
translate status [dir] [--to <lang>]                Translated, to translate and stale units; broken maths or placeholders
translate build [dir] --to <lang> --out <dir> [--allow-missing] [--json]
                                                    Generate the translated course (then elabora build it as any course)
translate approve [dir] --to <lang> --by "<name, organisation>" [--reference <ref>]
                                                    Approve the translated plan (human decision, kept with the source)
```

## Interoperability

```text
lesson-md export [dir] [--out <dir>]                Export simple blocks to LESSON.md 1.9 (Slate), with a loss report
lesson-md import [dir] <lesson.md> --covers ITEM-n [--id <screen-id>] [--section <id>] [--after <screen-id>]
```

## Agents

```text
mcp [dir] [--read-only] [--tools <name>,…]           MCP server on stdio, scoped to one course folder; optionally expose
                                                    only the named agent tools (unknown names are refused)
codes [--json]                                      Catalogue of diagnostic codes
docs [<page>] [--section <heading>] [--full]        The documentation as Markdown, without a checkout: the map of pages,
                                                    a page (D29: a decision; a long one as its outline), or one section
rules [dir] [--json]                                The rules for agents of this elabora (what a course's AGENTS.md
                                                    holds between its markers), and where the course's stand
rules update [dir] [--force] [--json]               Bring the course's AGENTS.md rules up to date (done by itself
                                                    while nobody edits them); --force replaces edited ones, the
                                                    notes after « elabora:rules end » kept. One undoable change
```

## Agent operations (shared with MCP)

```text
tools skills [<name> [<reference>]] [--json]         List bundled skills, or read one skill/on-demand recipe (no course needed)
tools guide [--json]                               Agent workflows, transport choices and human decisions (no course needed)
tools list [<tool>] [--read-only] [--tools <name>,…] [--json]
                                                    Discover agent operations and their JSON input schemas (no course needed)
tools call <tool> [dir] [--args '<json>' | --from <arguments.json>|-] [--read-only] [--raw]
                                                    Call the same operation as MCP, with the same validation. Arguments
                                                    default to {}: --args takes them inline, --from from a file (- reads
                                                    stdin). Prints the tool's own JSON (its text when it answers in text);
                                                    images go to files under the course's .elabora/look/, their paths in
                                                    "images". --raw prints the MCP result (content, isError) instead.
                                                    Exit 0 success, 1 refused, 2 bad input
```
