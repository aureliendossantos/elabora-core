# Module templates

A template is a course whose content is abstract and whose charter is the product: a theme, fonts, components, an animated backdrop and its variants ([D68](../docs/decisions/D68.md)). Start a course from one:

```bash
node bin/elabora.js templates
node bin/elabora.js init my-course --template organic --id my-course --title "My course" --lang en
```

The course is a copy of the template under your id and title, in the language asked (each template is written in English and translated into French). Each template's `README.md` says how its charter works and how to make it a brand's.

| Template | The backdrop and its movement | For |
|---|---|---|
| [`organic`](organic/) | Soft gradient blobs drift and migrate at each screen, from warm to cool tones, one hue per part | soft skills, wellbeing, onboarding, HR |
| [`flow`](flow/) | Luminous ribbons and particles on a dark field: the particles leap at each screen, then settle | tech, cybersecurity, launches, sales |
| [`clear`](clear/) | One accent on white: a short rule under the top bar moves to the part in progress | compliance, procedures, HR, internal communication |
| [`shapes`](shapes/) | Bauhaus shapes in flat colours: a new tableau for each part, one shape moving at each screen | methods, frameworks, processes, young learners |
| [`editorial`](editorial/) | The magazine page: rules and folios, a thumb tab per part that unfolds into a colour plate on a part opener; the folio turns at each screen | culture, history, management, long reads |
| [`paper`](paper/) | Cut paper on kraft with real soft shadows: a paper theatre whose hills slide at each screen and whose scene changes at each part, in stop motion | storytelling, primary school, associations, awareness |
| [`watercolor`](watercolor/) | Washes of water tones on cold-pressed paper: at each screen a new wash spreads from where the last one was, one tone per part | arts, care, sensitive subjects |

## The same screens in every template

Every template has these 14 screens, with the same ids, titles and order, in the same five sections (`opening`, `part-1`, `part-2`, `part-3`, `closing`) and the same plan: moving from one template to another, an author finds the same module in another charter.

| # | Screen | What it shows |
|---|---|---|
| 1 | `cover` | The module's title and lead: the library's thumbnail. A course made from the template gets its title here. |
| 2 | `objectives` | What the learner will be able to do |
| 3 | `part-one` | A part opener: the part's number as the charter sets it, its title and lead |
| 4 | `key-message` | One sentence, set large, without a screen title |
| 5 | `text-and-picture` | A text beside an abstract illustration drawn from the tokens |
| 6 | `cards` | Three ideas side by side |
| 7 | `key-figures` | Three key figures and their source |
| 8 | `practice` | A question with compact feedback |
| 9 | `steps` | Four steps in order |
| 10 | `quote` | A quotation, without a screen title |
| 11 | `comparison` | Two ways of doing it, face to face |
| 12 | `chart` | A chart and its takeaway |
| 13 | `recap` | What to remember |
| 14 | `the-end` | Thanks and where to go next |

Every screen is made of the core's blocks, so an author changes a block, adds one or rewords any text from the editor; a screen added later takes the charter as it is. The placeholder texts have their real length, so the layout holds when the real texts come.

## Adding a template

A template passes what a course passes: `elabora validate` (only `W_PLAN_DRAFT` and `W_SPACING_MISSING`), `elabora fit` at 1600×900 and 1280×720 with no contrast finding on the backdrop, `elabora test` (the LMS emulator, axe, no overflow at 375 px), `elabora object test` for its backdrop object, and its French translation complete, the words of its charter included (what its styles and backdrop variants are for, its components' names, descriptions, slots and settings): a module made in French from it has no English left in the Charte or the inspector. It is CC0, its fonts are under the SIL OFL and embedded, and nothing comes from the network or is generated in the folder (`dist/`, captures). Add it to `index.json` with its name, summary and audiences in English and French. `test/unit/templates.test.ts` checks all of it but the browser checks, which `test/matrix/templates.test.ts` runs.
