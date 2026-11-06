---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

The package's languages are the author's choice (D71). `course.json delivery.languages` (schema 0.1.11) lists them, the course's own always in, or says `"all"` (every translation ready and approved); `elabora build --languages en,fr`, `elabora publish --languages`, MCP `elabora_build` `languages: ["en", "fr"]` and `build({ languages })` take the same for one build. A translation named goes in as it is: not approved (`W_PACKAGE_LANGUAGE_NOT_APPROVED`, an error in `--release` only), with texts still to translate (`W_PACKAGE_LANGUAGE_INCOMPLETE`), or left out when the course has no translation in it (`W_PACKAGE_LANGUAGE_UNKNOWN`). `elabora preview` tries every translation, approved or not, with « Langue » shown. « Langue » is in a new course's top bar and shows once the package holds two languages. A learner starts in their own choice (now kept for the course's own language too), else `?lang=`, else the language preference their LMS gives (SCORM 1.2 `cmi.student_preference.language`, matched loosely: `fr_FR` opens French), else `delivery.defaultLanguage`, else the course's own (`W_PACKAGE_DEFAULT_LANGUAGE` when the package lacks it). `delivery.languagePackages: "each"` (`elabora build --packages each`, `buildLanguagePackages`) makes one package per language instead, for LMSs that keep a course's language versions themselves.
