import type { PlanApprovalState } from '../project/plan-versions.ts';
import type { BuildReport, GatesStatus, ReportFit } from './report.ts';

// Human-readable proof dossier (Markdown) generated from the build report: conformity to the
// validated plan screen by screen, tracking, accessibility status, LMS targets, open points.

// The words of the dossier in one language.
interface ProofWords {
  title: string; colon: string; sep: string; course: string; version: string; build: string; package: string; generated: string;
  plan: string; status: string; approvedBy: string; hash: string; approvalStates: Partial<Record<PlanApprovalState, string>>;
  validatedVersion: (version: string, by: string, date: string, reference: string | null) => string; changesSince: (version: string, count: number) => string;
  changeStatus: Record<'added' | 'removed' | 'changed', string>; changeKinds: Record<'plan' | 'objective' | 'item' | 'text' | 'question' | 'source', string>; verbatimChanged: string;
  conformity: string; item: string; kind: string; screens: string; texts: string; questions: string; activities: string;
  objectives: string; objective: string; none: string; tracking: string; budget: string; profiles: string; update: string; toMeasure: string;
  objects: string; gates: string; media: string; voices: string; diagnostics: string; errors: string; warnings: string; infos: string; waived: string; ignored: string;
  pending: string; tests: string; noTests: string; spacing: string; goal: string;
  files: string; kb: string; profile: string; launch: string; browser: string; result: string; axe: (violations: number, screens: number) => string; fit: (fit: ReportFit) => string;
  components: string; component: string; level: string; layout: string; block: string; parent: string; origin: string; uses: string;
  componentNote: string;
  automated: (gates: GatesStatus) => string;
  humanGates: string;
  pendingItems: Record<string, string>;
  objectReview: (id: string) => string;
  // The web target (D41).
  web: { package: string; heading: string; progress: Record<'local' | 'none', string>; navigation: Record<'authored' | 'free', string>; noindex: string; indexed: string; url: string; image: string; noUrl: string; review: string };
}

const WORDS: Record<'fr' | 'en', ProofWords> = {
  fr: {
    title: 'Dossier de preuve', colon: '\u202f: ', sep: '\u202f; ', course: 'Module', version: 'Version', build: 'Build', package: 'Paquet', generated: 'Généré par Elabora',
    plan: 'Plan', status: 'Statut', approvedBy: 'Validé par', hash: 'Empreinte du plan', approvalStates: { draft: 'aucune version validée', modified: 'modifié depuis sa version validée', approved: 'version validée' },
    validatedVersion: (version, by, date, reference) => `${version}, validée par ${by} le ${date}${reference ? ` (${reference})` : ''}`, changesSince: (version, count) => `${count} modification(s) depuis la ${version} validée, livrées sans validation du client`,
    changeStatus: { added: 'ajouté', removed: 'retiré', changed: 'modifié' }, changeKinds: { plan: 'Plan', objective: 'Objectif', item: 'Point', text: 'Texte', question: 'Question', source: 'Source' }, verbatimChanged: 'texte « à l’identique » modifié',
    conformity: 'Conformité au plan, élément par élément', item: 'Élément', kind: 'Nature', screens: 'Écrans', texts: 'Textes verrouillés', questions: 'Questions validées', activities: 'Activités',
    objectives: 'Objectifs', objective: 'Objectif', none: '—', tracking: 'Suivi SCORM 1.2', budget: 'suspend_data (pire cas / limite)', profiles: 'LMS ciblés', update: 'Mise à jour', toMeasure: 'à mesurer',
    objects: 'Objets libres', gates: 'Portes', media: 'Médias générés par IA (AI Act, art. 50)', voices: 'Voix de la narration : crédits', diagnostics: 'Constats de validation', errors: 'erreurs', warnings: 'avertissements', infos: 'informations', waived: 'dérogations', ignored: 'ignorés par l’auteur',
    pending: 'Reste à faire (portes humaines)', tests: 'Essais LMS (émulateur)', noTests: 'Pas encore exécutés : `elabora test`.', spacing: 'Rappels espacés', goal: 'Objectif métier',
    files: 'fichiers', kb: 'Ko', profile: 'Profil', launch: 'Lancement', browser: 'Navigateur', result: 'Résultat', axe: (violations, screens) => `axe-core : ${violations} violation(s) sur ${screens} écrans et états.`, fit: (fit) => `Diapositives à ${fit.size.replace('x', '×')} (${fit.role === 'reference' ? 'taille de référence' : 'taille minimale'}) : ${fit.fit}/${fit.screens} tiennent sans défiler${fit.overflow.length ? ` ; défilent : ${fit.overflow.map((screen) => `${screen.screen} (+${screen.px} px)`).join(', ')}` : ''}.`,
    components: 'Composants du module', component: 'Composant', level: 'Niveau', layout: 'mise en page', block: 'bloc', parent: 'Dérivé de', origin: 'Bibliothèque', uses: 'Utilisations',
    componentNote: 'Gabarits sans code, revus sur captures (`elabora component preview`) ; les activités dérivées gardent le comportement natif (score, sauvegarde, SCORM).',
    automated: (gates) => ({
      passed: `portes 2 à 6 réussies le ${day(gates.at)} (Elabora ${gates.elabora}${gates.bootMs != null ? `, démarrage ${gates.bootMs} ms` : ''})`,
      failed: `portes 2 à 6 en échec le ${day(gates.at)} : relancer \`elabora object test\` après correction`,
      stale: `objet modifié depuis le dernier passage des portes 2 à 6 (${day(gates.at)}) : relancer \`elabora object test\``,
      'not-run': 'portes 2 à 6 jamais passées : `elabora object test`'
    }[gates.status]),
    humanGates: 'relecture pédagogique et revue de code (portes 7 et 8) à faire',
    pendingItems: {
      'accessibility-manual': 'Accessibilité : les contrôles axe-core tournent avec `elabora test` ; les critères RGAA / WCAG 2.2 non automatisables demandent une revue manuelle (garde-fou F2).',
      'sme-review': 'Relecture par un expert métier de chaque question d’évaluation (garde-fou C3) et des affirmations factuelles (G2).',
      'lms-smoke': 'Essai dans SCORM Cloud et avec un apprenant test sur la plateforme du client (niveaux 5 et 6 de la pyramide).',
      'web-smoke': 'Essai à l’adresse publiée : ouvrir le module, recharger, et vérifier l’aperçu de partage.'
    },
    objectReview: (id) => `Objet libre \`${id}\` : relecture pédagogique et revue de code (portes 7 et 8).`,
    web: {
      package: 'Web (serveur statique, sans LMS)', heading: 'Diffusion web',
      progress: { local: 'Progression : gardée dans le navigateur (localStorage), reprise d’une visite à l’autre', none: 'Progression : rien n’est gardé ; un rechargement recommence le module' },
      navigation: { authored: 'Navigation : telle que conçue (verrous du module)', free: 'Navigation : libre, tous les écrans ouverts, sans verrou' },
      noindex: 'Moteurs de recherche : non indexé (noindex)', indexed: 'Moteurs de recherche : indexable', url: 'Adresse', image: 'Image de partage', noUrl: 'aucune (les aperçus de partage demandent une adresse absolue)',
      review: 'Revue : pont elabora-review/1 avec les pages de'
    }
  },
  en: {
    title: 'Proof dossier', colon: ': ', sep: '; ', course: 'Course', version: 'Version', build: 'Build', package: 'Package', generated: 'Generated by Elabora',
    plan: 'Plan', status: 'Status', approvedBy: 'Approved by', hash: 'Plan hash', approvalStates: { draft: 'no validated version', modified: 'changed since its validated version', approved: 'validated version' },
    validatedVersion: (version, by, date, reference) => `${version}, validated by ${by} on ${date}${reference ? ` (${reference})` : ''}`, changesSince: (version, count) => `${count} change(s) since validated ${version}, delivered without the client's validation`,
    changeStatus: { added: 'added', removed: 'removed', changed: 'changed' }, changeKinds: { plan: 'Plan', objective: 'Objective', item: 'Item', text: 'Text', question: 'Question', source: 'Source' }, verbatimChanged: 'text kept word for word changed',
    conformity: 'Conformity to the plan, item by item', item: 'Item', kind: 'Kind', screens: 'Screens', texts: 'Locked texts', questions: 'Validated questions', activities: 'Activities',
    objectives: 'Objectives', objective: 'Objective', none: '—', tracking: 'SCORM 1.2 tracking', budget: 'suspend_data (worst case / limit)', profiles: 'Target LMSs', update: 'Update', toMeasure: 'to measure',
    objects: 'Free objects', gates: 'Gates', media: 'AI-generated media (AI Act, art. 50)', voices: 'Narration voices: credits', diagnostics: 'Validation findings', errors: 'errors', warnings: 'warnings', infos: 'infos', waived: 'waivers', ignored: 'ignored by the author',
    pending: 'Still to do (human gates)', tests: 'LMS trials (emulator)', noTests: 'Not run yet: `elabora test`.', spacing: 'Spaced retrieval', goal: 'Business goal',
    files: 'files', kb: 'KB', profile: 'Profile', launch: 'Launch', browser: 'Browser', result: 'Result', axe: (violations, screens) => `axe-core: ${violations} violation(s) on ${screens} screen states.`, fit: (fit) => `Slides at ${fit.size.replace('x', '×')} (${fit.role} size): ${fit.fit}/${fit.screens} fit without scrolling${fit.overflow.length ? `; scroll: ${fit.overflow.map((screen) => `${screen.screen} (+${screen.px} px)`).join(', ')}` : ''}.`,
    components: 'Course components', component: 'Component', level: 'Level', layout: 'layout', block: 'block', parent: 'Forked from', origin: 'Library', uses: 'Uses',
    componentNote: 'Templates without code, reviewed on screenshots (`elabora component preview`); forks of activities keep the built-in behaviour (scoring, saved state, SCORM).',
    automated: (gates) => ({
      passed: `gates 2–6 passed on ${day(gates.at)} (Elabora ${gates.elabora}${gates.bootMs != null ? `, boot ${gates.bootMs} ms` : ''})`,
      failed: `gates 2–6 failed on ${day(gates.at)}: run \`elabora object test\` again after the fix`,
      stale: `object changed since gates 2–6 last ran (${day(gates.at)}): run \`elabora object test\` again`,
      'not-run': 'gates 2–6 never run: `elabora object test`'
    }[gates.status]),
    humanGates: 'pedagogical review and code review (gates 7 and 8) pending',
    pendingItems: {
      'accessibility-manual': 'Accessibility: automated axe-core checks run with `elabora test`; RGAA / WCAG 2.2 criteria that cannot be automated need a manual review (guardrail F2).',
      'sme-review': 'Subject-matter expert review of every assessment item (guardrail C3) and of factual claims (G2).',
      'lms-smoke': 'Smoke test in SCORM Cloud and a test learner in the client LMS (pyramid levels 5 and 6).',
      'web-smoke': 'Trial at the published address: open the course, reload it and check the sharing preview.'
    },
    objectReview: (id) => `Free object \`${id}\`: pedagogical review and code review (gates 7 and 8).`,
    web: {
      package: 'Web (static server, no LMS)', heading: 'Web delivery',
      progress: { local: 'Progress: kept in the browser (localStorage), resumed from one visit to the next', none: 'Progress: nothing is kept; a reload starts the course again' },
      navigation: { authored: 'Navigation: as designed (the course\'s locks)', free: 'Navigation: free, every screen open, no lock' },
      noindex: 'Search engines: not indexed (noindex)', indexed: 'Search engines: indexable', url: 'Address', image: 'Sharing image', noUrl: 'none (sharing previews need an absolute address)',
      review: 'Review: elabora-review/1 bridge with the pages of'
    }
  }
};

const day = (iso: string | null | undefined): string => String(iso || '').slice(0, 10);

const cell = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const wordsFor = (language: string): ProofWords => { const short = language.slice(0, 2); return short === 'fr' || short === 'en' ? WORDS[short] : WORDS.en; };
const used = (usedBy: string[]): string => (usedBy.length ? '✔' : '✘');

export function proofMarkdown(report: BuildReport): string {
  const words = wordsFor(report.course.language || 'en');
  const lines: string[] = [];
  const { plan } = report;
  lines.push(`# ${words.title} — ${report.course.title}`, '');
  lines.push(`- **${words.course}**${words.colon}\`${report.course.id}\` · **${words.version}** ${report.course.version} · **${words.build}** \`${report.buildId}\``);
  lines.push(`- **${words.package}**${words.colon}${report.web ? words.web.package : 'SCORM 1.2'}, ${report.package.files} ${words.files}, ${(report.package.bytes / 1024).toFixed(0)} ${words.kb}, SHA-256 \`${report.package.sha256}\``);
  lines.push(`- ${words.generated} ${report.elabora}`, '');
  lines.push(`## ${words.plan}`, '');
  lines.push(`- **${plan.id}** — ${plan.title}`);
  lines.push(`- **${words.status}**${words.colon}${words.approvalStates[plan.approvalState] || plan.approvalState}${plan.validated ? ` · **${words.approvedBy}** ${words.validatedVersion(plan.validated.version, plan.validated.by, plan.validated.date, plan.validated.reference)}` : ''}`);
  lines.push(`- **${words.hash}**${words.colon}\`${plan.contentHash}\``);
  if (plan.changesSince?.changes.length) {
    const since = plan.changesSince;
    lines.push(`- **${words.changesSince(since.version, since.changes.length)}**${words.colon}`);
    for (const change of since.changes) lines.push(`  - ${words.changeKinds[change.kind]} ${change.id}${change.label && change.label !== change.id ? ` « ${cell(change.label)} »` : ''}${words.colon}${words.changeStatus[change.status]}${since.verbatim.includes(change.id) ? ` (${words.verbatimChanged})` : ''}`);
  }
  if (plan.businessGoal) lines.push(`- **${words.goal}**${words.colon}${plan.businessGoal}`);
  if (plan.spacing?.length) lines.push(`- **${words.spacing}**${words.colon}${plan.spacing.join(', ')}`);
  lines.push('', `### ${words.objectives}`, '');
  for (const objective of plan.objectives) lines.push(`- **${objective.id}** ${objective.statement}${objective.bloom ? ` _(${objective.bloom})_` : ''}`);
  lines.push('', `## ${words.conformity}`, '');
  lines.push(`| ${words.item} | ${words.kind} | ${words.objectives} | ${words.screens} | ${words.texts} | ${words.questions} | ${words.activities} |`, '|---|---|---|---|---|---|---|');
  for (const item of plan.coverage) {
    const texts = item.lockedTexts.map((text) => `${text.id} ${used(text.usedBy)}`).join(', ') || words.none;
    const questions = item.questions.map((question) => `${question.id} ${used(question.usedBy)}`).join(', ') || words.none;
    lines.push(`| ${cell(`${item.id} ${item.title}`)} | ${item.kind} | ${item.objectives.join(', ') || words.none} | ${item.screens.join(', ') || '✘'} | ${texts} | ${questions} | ${cell(item.activities.join(', ')) || words.none} |`);
  }
  if (report.web) {
    const { web } = report;
    lines.push('', `## ${words.web.heading}`, '');
    lines.push(`- ${words.web.progress[web.progress]}`, `- ${words.web.navigation[web.navigation]}`, `- ${web.noindex ? words.web.noindex : words.web.indexed}`);
    lines.push(`- **${words.web.url}**${words.colon}${web.url ?? words.web.noUrl}`);
    if (web.image) lines.push(`- **${words.web.image}**${words.colon}\`${web.image}\``);
    if (web.review) lines.push(`- ${words.web.review} ${web.review.origins.map((origin) => `\`${origin}\``).join(', ')}`);
  } else {
    lines.push('', `## ${words.tracking}`, '');
    lines.push(`- **${words.budget}**${words.colon}${report.budget.suspendDataWorstCase} / ${report.budget.suspendDataLimit} (${report.budget.source})`);
    lines.push(`- **${words.profiles}** :`);
    for (const profile of report.profiles) lines.push(`  - ${profile.name} (${profile.documentedAt}) — ${words.update}${words.colon}${profile.updateFamily ?? '?'}${profile.toMeasure?.length ? ` — ${words.toMeasure}${words.colon}${profile.toMeasure.join(', ')}` : ''}`);
    lines.push('', `## ${words.tests}`, '');
    if (!report.tests) lines.push(words.noTests);
    else {
      lines.push(`| ${words.profile} | ${words.launch} | ${words.browser} | ${words.result} |`, '|---|---|---|---|');
      for (const run of report.tests.runs) lines.push(`| ${run.profile} | ${run.launch} | ${run.browser} | ${run.ok ? '✔' : `✘ ${cell(run.failures.map((failure) => failure.code).join(', '))}`} |`);
      if (report.tests.accessibility) lines.push('', words.axe(report.tests.accessibility.violations, report.tests.accessibility.screens));
      for (const fit of report.tests.fit || []) lines.push('', words.fit(fit));
    }
  }
  if (report.components?.length) {
    lines.push('', `## ${words.components}`, '', words.componentNote, '');
    lines.push(`| ${words.component} | ${words.version} | ${words.level} | ${words.parent} | ${words.origin} | ${words.uses} |`, '|---|---|---|---|---|---|');
    for (const component of report.components) lines.push(`| ${cell(`${component.id} — ${component.title}`)} | ${component.version} | ${component.level === 'screen' ? words.layout : words.block} | ${component.extends || words.none} | ${cell(component.origin || words.none)} | ${component.instances} |`);
  }
  if (report.objects.length) {
    lines.push('', `## ${words.objects}`, '');
    for (const object of report.objects) lines.push(`- **${object.id}** v${object.version} — ${object.pedagogicalRole}${object.planRefs?.objectives?.length ? `, ${words.objective} ${object.planRefs.objectives.join(', ')}` : ''} — ${words.gates}${words.colon}${object.gates.automated.status === 'passed' ? '✔' : '✘'} ${words.automated(object.gates.automated)}${words.sep}${words.humanGates}`);
  }
  if (report.generatedMedia.length) {
    lines.push('', `## ${words.media}`, '');
    for (const media of report.generatedMedia) lines.push(`- ${media.type} \`${media.block}\` (${media.screen})`);
  }
  if (report.narration?.credits?.length) {
    lines.push('', `## ${words.voices}`, '');
    for (const credit of report.narration.credits) lines.push(`- ${cell(credit)}`);
  }
  lines.push('', `## ${words.diagnostics}`, '');
  lines.push(`${report.summary.errors} ${words.errors}, ${report.summary.warnings} ${words.warnings}, ${report.summary.infos} ${words.infos}, ${report.summary.waived} ${words.waived}${report.summary.ignored ? `, ${report.summary.ignored} ${words.ignored}` : ''}.`, '');
  for (const diagnostic of report.diagnostics) lines.push(`- \`${diagnostic.code}\` ${diagnostic.waived ? `(${words.waived}${words.colon}${diagnostic.waived.reason} — ${diagnostic.waived.approvedBy}) ` : diagnostic.ignored ? `(${words.ignored}) ` : ''}${cell(diagnostic.message)}${diagnostic.file ? ` — ${diagnostic.file}${diagnostic.path ? ` ${diagnostic.path}` : ''}` : ''}`);
  lines.push('', `## ${words.pending}`, '');
  for (const item of report.pending) lines.push(`- [ ] ${item.startsWith('object-review:') ? words.objectReview(item.slice(14)) : words.pendingItems[item] || item}`);
  return lines.join('\n') + '\n';
}
