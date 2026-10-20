// The review bridge (docs/review-bridge.md, docs/decisions.md D42): bundled as elabora/review.js into
// review builds only (elabora build --target web --review-origin …), loaded after player.js. It speaks
// elabora-review/1 (review-protocol.ts) with the review page that shows the module in an iframe:
// - it takes messages from the window that embeds it only, and only from an origin the build named;
//   it posts to that origin only (to each named origin until the page has spoken: postMessage drops a
//   message whose target origin is not the page's); it opens no connection of its own;
// - it tells the page where the reviewer is and where every block is, as they change (screen, step,
//   layer, narration, size, scroll), at most once a frame and only when something changed;
// - it goes to an anchor, pauses and resumes the narration, keeps a margin on the right for a
//   floating panel, and says what text size and column a frame of another size would give.
// It drives the player through the hooks it exposes (window.__elabora: go, reveal, openLayer,
// timeline), which ship in the same build: the protocol is the stable surface, not the hooks.
// Nothing here runs outside an iframe, nor in a module built without --review-origin.

import { isRecord } from './json.ts';
import { blockLayouts, round, scrollFrom } from './layout-report.ts';
import { REVIEW_PROTOCOL, SIZE_RULES, acceptsFrom, otherVersion, reviewPeer, readPageMessage, textScale, widestColumn, wordAt, wordTime } from './review-protocol.ts';
import type { AnchorPart, BlocksMessage, GoTarget, LayoutMessage, LocationMessage, ModuleMessage, PageMessage, ReadyMessage, ReviewBlock } from './review-protocol.ts';
import type { BlockData, NarrationData, ScreenData } from './course-data.ts';

const course = window.ELABORA_COURSE;
const review = course.delivery?.review;
const hooks = window.__elabora;

function startBridge(origins: readonly string[]) {
  // The page's origin: the embedder's when the browser tells it (Chrome, Safari) and it is allowed,
  // else every allowed origin until a message comes from one of them.
  const first = reviewPeer(origins, location.ancestorOrigins?.[0]);
  // An embedder the build did not name: the module says nothing to it, and listens to nothing.
  if (first.silent) return;
  let peer = first.peer;

  type Out = ModuleMessage extends infer M ? M extends ModuleMessage ? Omit<M, 'protocol'> : never : never;
  function post(message: Out) {
    const full = { protocol: REVIEW_PROTOCOL, ...message };
    for (const origin of peer ? [peer] : origins) window.parent.postMessage(full, origin);
  }

  window.addEventListener('message', (event) => {
    if (!acceptsFrom(origins, peer, { origin: event.origin, fromParent: event.source === window.parent })) return;
    const message = readPageMessage(event.data);
    if (!message) {
      const re = isRecord(event.data) && (typeof event.data.id === 'string' || typeof event.data.id === 'number') ? { re: event.data.id } : {};
      if (otherVersion(event.data)) { peer = event.origin; post({ type: 'error', ...re, message: `This module speaks ${REVIEW_PROTOCOL}.` }); }
      else if (isRecord(event.data) && event.data.protocol === REVIEW_PROTOCOL) { peer = event.origin; post({ type: 'error', ...re, message: `Not a message of ${REVIEW_PROTOCOL}: ${JSON.stringify(event.data.type)}.` }); }
      return;
    }
    peer = event.origin;
    receive(message);
  });

  const style = document.createElement('style');
  style.dataset.elaboraReview = '';
  // The column moved into the room the page leaves (layout), and the block a comment points at (go).
  style.textContent = `#elabora-app[data-elabora-review-shift] #t-main > .t-screen { translate: var(--elabora-review-shift) 0; transition: translate .25s ease; }
[data-elabora-review-target] { outline: 3px solid #2563eb; outline-offset: 4px; border-radius: 4px; animation: elabora-review-ping 0.6s ease-in-out 2; }
@keyframes elabora-review-ping { 50% { outline-offset: 10px; outline-color: rgb(37 99 235 / 0.35); } }
@media (prefers-reduced-motion: reduce) { [data-elabora-review-target] { animation: none; } #elabora-app[data-elabora-review-shift] #t-main > .t-screen { transition: none; } }`;
  document.head.append(style);

  const app = document.getElementById('elabora-app') as HTMLElement;
  const screenOf = (): ScreenData | undefined => course.screens.find((screen) => screen.id === hooks.screen);

  // ── ready ───────────────────────────────────────────────────────────
  function ready(): Omit<ReadyMessage, 'protocol'> {
    const sections = new Map<string, string>();
    for (const section of course.sections) for (const id of section.screens) sections.set(id, section.id);
    return {
      type: 'ready', build: { id: course.build.id }, course: { id: course.id, version: course.version, title: course.title },
      language: course.language, languages: review?.languages.length ? [...review.languages] : [course.language],
      presentation: course.presentation?.mode === 'slides' ? 'slides' : 'scroll',
      screens: course.screens.map((screen) => ({ key: screen.key, id: screen.id, title: screen.title, section: sections.get(screen.id) ?? screen.section }))
    };
  }

  // ── layout: text size, column, the margin kept for the page ─────────
  let inset = 0;
  let shift = 0;
  // The side padding (rem) and the column's cap (rem) of a screen with a column, read from a probe
  // styled as the player and the course style a screen.
  function columnRules(fontSize: number): { paddingRem: number; capRem: number } {
    const probe = document.createElement('main');
    probe.className = 't-main';
    probe.hidden = true;
    const article = document.createElement('article');
    article.className = 't-screen';
    probe.append(article);
    app.append(probe);
    const paddingRem = (parseFloat(getComputedStyle(probe).paddingLeft) || 0) / fontSize;
    const cap = parseFloat(getComputedStyle(article).maxWidth);
    probe.remove();
    return { paddingRem, capRem: Number.isFinite(cap) ? cap / fontSize : Infinity };
  }
  const frame = () => ({ width: innerWidth, height: innerHeight });
  const scrollbar = () => Math.max(0, innerWidth - document.documentElement.clientWidth);
  function sizes() {
    const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const baseFontSize = fontSize / textScale(frame());
    return { fontSize, baseFontSize, ...columnRules(fontSize) };
  }

  // Moves the column into the room the page leaves on the right, when it keeps its width there.
  function applyInset() {
    const article = document.querySelector<HTMLElement>('#t-main > article.t-screen');
    const main = document.getElementById('t-main');
    let next = 0;
    if (inset > 0 && article && main && !main.hasAttribute('data-full-bleed')) {
      const room = document.documentElement.clientWidth - inset;
      const style = getComputedStyle(main);
      const left = parseFloat(style.paddingLeft) || 0;
      const right = parseFloat(style.paddingRight) || 0;
      const width = article.getBoundingClientRect().width;
      if (width + left + right <= room + 0.5) {
        // The column's centre where the page lays it (main is never moved; the column's own
        // translation, under way or done, does not count).
        const box = main.getBoundingClientRect();
        const centre = box.left + left + (box.width - left - right) / 2;
        next = Math.min(0, round(room / 2 - centre));
      }
    }
    if (next === shift && (next !== 0) === app.hasAttribute('data-elabora-review-shift')) return;
    shift = next;
    if (shift) { app.style.setProperty('--elabora-review-shift', `${shift}px`); app.setAttribute('data-elabora-review-shift', ''); }
    else { app.removeAttribute('data-elabora-review-shift'); app.style.removeProperty('--elabora-review-shift'); }
  }

  function layout(): Omit<LayoutMessage, 'protocol'> {
    const { fontSize, baseFontSize, paddingRem, capRem } = sizes();
    const main = document.getElementById('t-main');
    const article = document.querySelector<HTMLElement>('#t-main > article.t-screen');
    // The player's bars (D58): the top one, and the bottom one or the strip of a narrated screen's controls.
    const header = document.querySelector<HTMLElement>('#elabora-app > .t-bar--top');
    const footer = document.querySelector<HTMLElement>('#elabora-app > .t-bar--bottom:not([hidden])') ?? document.querySelector<HTMLElement>('#elabora-app > .t-bar--controls');
    const fullBleed = !!main?.hasAttribute('data-full-bleed');
    return {
      type: 'layout', frame: frame(), fontSize: round(fontSize), baseFontSize: round(baseFontSize), sizes: SIZE_RULES,
      column: { width: round(article?.getBoundingClientRect().width ?? 0), max: round(Math.min(capRem * fontSize, 1e6)), fullBleed },
      widest: widestColumn(frame(), { baseFontSize, capRem, paddingRem, scrollbar: scrollbar() }).widest,
      inset: { right: inset, shifted: shift !== 0 },
      chrome: { top: round(header && !header.hidden ? header.offsetHeight : 0), bottom: round(footer && !footer.hidden ? footer.offsetHeight : 0) }
    };
  }

  function measure(size: { width: number; height: number }) {
    const { baseFontSize, paddingRem, capRem } = sizes();
    return widestColumn(size, { baseFontSize, capRem, paddingRem, scrollbar: scrollbar() });
  }

  // ── location ────────────────────────────────────────────────────────
  const openLayer = (): string | null => {
    const open = [...document.querySelectorAll<HTMLDialogElement>('dialog.t-layer[open]')];
    return open.length ? open[open.length - 1].dataset.layer ?? null : null;
  };
  function where(): Omit<LocationMessage, 'protocol'> {
    const screen = screenOf();
    const { revealed, steps } = hooks.step;
    const message: Omit<LocationMessage, 'protocol'> = {
      type: 'location', screen: screen?.key ?? '', index: screen ? course.screens.indexOf(screen) : -1, step: revealed, steps: [...steps], layer: openLayer(), held: held !== null
    };
    const state = hooks.timeline.state();
    if (state && screen?.narration) {
      message.time = Math.round(state.time * 1000) / 1000;
      message.duration = Math.round(state.duration * 1000) / 1000;
      message.playing = state.playing;
      const line = screen.narration.lines.find((candidate) => candidate.id === state.line);
      if (line) {
        message.line = line.id;
        const said = wordAt(line.words ?? [], state.time);
        if (said) { message.word = said.word; if (said.occurrence > 1) message.occurrence = said.occurrence; }
        // The line's text and speaker, as the captions show them: the page says « when Marc says "…" ».
        if (line.text) message.said = line.text;
        if (line.speaker) message.speaker = line.speaker;
      }
    }
    return message;
  }

  // ── blocks ──────────────────────────────────────────────────────────
  function blocks(): Omit<BlocksMessage, 'protocol'> {
    const screen = screenOf();
    const names = kindNames();
    const found = blockLayouts().map((layout) => {
      const data = hooks.engine.blockIndex.get(layout.id)?.block;
      const node = document.querySelector<HTMLElement>(`dialog.t-layer[open] [data-block="${CSS.escape(layout.id)}"], #t-main [data-block="${CSS.escape(layout.id)}"]`);
      return { layout, data, kind: kindOf(data), label: node ? labelOf(node) : null };
    });
    // Blocks without words are numbered among those of their kind on the screen.
    const total = new Map<string, number>();
    for (const { kind } of found) total.set(kind, (total.get(kind) ?? 0) + 1);
    const seen = new Map<string, number>();
    const listed = found.map(({ layout, data, kind, label }, index): ReviewBlock => {
      const nth = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, nth);
      const kindName = names[kind] ?? names.component;
      return {
        id: layout.id, type: data?.type ?? kind, kind, name: label ? `${kindName} · ${label}` : (total.get(kind) ?? 0) > 1 ? `${kindName} ${nth}` : kindName, label,
        order: index + 1, rect: layout.rect, layer: layout.layer, parent: layout.parent, hidden: layout.hidden, ...(data?.type === 'free-object' ? { object: true as const } : {})
      };
    });
    return { type: 'blocks', screen: screen?.key ?? '', step: hooks.step.revealed, layer: openLayer(), frame: frame(), scroll: { x: round(scrollX), y: round(scrollY) }, blocks: listed };
  }

  // ── Sending what changed ────────────────────────────────────────────
  const last = { layout: '', location: '', blocks: '' };
  function flush(force = false) {
    applyInset();
    const place = where();
    // While the narration plays, the time alone does not make a message: the word that changes does.
    const placeKey = JSON.stringify({ ...place, time: place.playing ? undefined : place.time });
    const shown = blocks();
    const shownKey = JSON.stringify(shown);
    const sized = layout();
    const sizedKey = JSON.stringify(sized);
    if (force || sizedKey !== last.layout) { last.layout = sizedKey; post(sized); }
    if (force || placeKey !== last.location) { last.location = placeKey; post(place); }
    if (force || shownKey !== last.blocks) { last.blocks = shownKey; post(shown); }
  }
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; observeBlocks(); flush(); });
  }
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  const watched = new Set<Element>();
  function observeBlocks() {
    if (!resizes) return;
    for (const node of watched) if (!node.isConnected) { resizes.unobserve(node); watched.delete(node); }
    for (const node of [document.documentElement, ...document.querySelectorAll('#t-main, #t-main .t-block[data-block], dialog.t-layer .t-block[data-block]')]) {
      if (!watched.has(node)) { resizes.observe(node); watched.add(node); }
    }
  }
  new MutationObserver(() => schedule()).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-t-pending', 'data-t-concealed', 'data-t-timed', 'open', 'hidden'] });
  addEventListener('scroll', schedule, { capture: true, passive: true });
  // The column gliding into the margin, and effects that move blocks: where they end.
  addEventListener('transitionend', schedule, true);
  addEventListener('animationend', schedule, true);
  addEventListener('resize', schedule);
  // The narration's time moves without the page changing: read it a few times a second. While the
  // page holds the narration (pause), a screen that starts playing is paused at once.
  setInterval(() => {
    const state = hooks.timeline.state();
    if (!state) return;
    if (held && state.playing) { hooks.timeline.pause(); held.playing = true; }
    schedule();
  }, 150);
  document.addEventListener('play', () => { if (held) { hooks.timeline.pause(); held.playing = true; } }, true);

  // ── Key C ───────────────────────────────────────────────────────────
  // C is the page's « Commenter » key, but a key pressed while the focus is inside the module stays in
  // the module's frame: the page never hears it. The module tells it, unless the key was for the
  // module (a text field, a modifier, a handler that took it).
  addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key !== 'c' && event.key !== 'C') return;
    if (typing(event.target)) return;
    post({ type: 'key', key: 'c' });
  });

  // ── Receiving ───────────────────────────────────────────────────────
  // The narration paused by the page, and whether it played then.
  let held: { playing: boolean } | null = null;
  let highlighted: HTMLElement | null = null;
  let unhighlight = 0;

  function receive(message: PageMessage) {
    const re = message.id !== undefined ? { re: message.id } : {};
    switch (message.type) {
      case 'hello': post(ready()); flush(true); return;
      case 'pause': {
        if (!held) held = { playing: !!hooks.timeline.state()?.playing };
        hooks.timeline.pause();
        schedule();
        return;
      }
      case 'resume': {
        const was = held;
        held = null;
        if (was?.playing) hooks.timeline.play();
        schedule();
        return;
      }
      case 'layout': {
        inset = Math.round(message.inset.right);
        applyInset();
        const sized = layout();
        last.layout = JSON.stringify(sized);
        post({ ...sized, ...re });
        schedule();
        return;
      }
      case 'measure': {
        const { fontSize, widest } = measure(message.frame);
        post({ type: 'measured', ...re, frame: message.frame, fontSize, widest });
        return;
      }
      case 'scroll': scrollFrom(message.by, message.at); return;
      case 'go': {
        const missing = go(message.anchor, message.highlight);
        post({ type: 'went', ...re, ok: missing.length === 0, missing });
        schedule();
        return;
      }
    }
  }

  // Goes to an anchor: the screen, the step, the moment (word, line, else time), the layer, then the
  // block scrolled into view and highlighted. Returns the parts not found.
  function go(target: GoTarget, highlight: boolean): AnchorPart[] {
    const missing: AnchorPart[] = [];
    const index = course.screens.findIndex((screen) => screen.key === target.screen);
    const at = index >= 0 ? index : course.screens.findIndex((screen) => screen.id === target.screen);
    if (at < 0) return ['screen'];
    const screen = course.screens[at];
    if (hooks.screen !== screen.id) hooks.go(at);
    if (hooks.screen !== screen.id) return ['screen'];
    const block = target.block ? hooks.engine.blockIndex.get(target.block) : undefined;
    if (target.block && (!block || block.screen.id !== screen.id)) missing.push('block');
    // The step named (it may be an earlier one), else the block's when it is not shown yet.
    if (target.step !== undefined) {
      if (hooks.step.steps.includes(target.step)) hooks.reveal(target.step);
      else missing.push('step');
    } else if (block && block.screen.id === screen.id && (block.block.step ?? 1) > hooks.step.revealed) hooks.reveal(block.block.step ?? 1);
    // The moment of a timed screen.
    const narration: NarrationData | undefined = screen.narration;
    if (narration && (target.line || target.time !== undefined)) {
      const line = target.line ? narration.lines.find((candidate) => candidate.id === target.line) : undefined;
      if (target.line && !line) missing.push('line');
      const wordStart = line && target.word ? wordTime(line.words ?? [], target.word, target.occurrence ?? 1) : null;
      if (line && target.word && wordStart === null) missing.push('word');
      if (wordStart !== null) hooks.timeline.atTime(wordStart + 0.001, { captions: false });
      else if (line) hooks.timeline.at(line.id, { captions: false });
      else if (target.time !== undefined) hooks.timeline.atTime(target.time, { captions: false });
    } else if (target.line || target.time !== undefined) missing.push(target.line ? 'line' : 'time');
    // The layer: the one named opens; the others close (they would hide the screen).
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer[open]')) if (dialog.dataset.layer !== target.layer) dialog.close();
    if (target.layer) {
      if (!screen.layers.some((layer) => layer.id === target.layer)) missing.push('layer');
      else hooks.openLayer(target.layer);
    }
    // The block, in view and highlighted (twice, or still under reduced motion).
    if (target.block && !missing.includes('block')) {
      const node = document.querySelector<HTMLElement>(`dialog.t-layer[open] [data-block="${CSS.escape(target.block)}"], #t-main [data-block="${CSS.escape(target.block)}"]`);
      if (!node) missing.push('block');
      else {
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        if (highlight) {
          highlighted?.removeAttribute('data-elabora-review-target');
          clearTimeout(unhighlight);
          node.setAttribute('data-elabora-review-target', '');
          highlighted = node;
          unhighlight = window.setTimeout(() => { node.removeAttribute('data-elabora-review-target'); if (highlighted === node) highlighted = null; }, 2000);
        }
      }
    }
    if (held && hooks.timeline.state()?.playing) hooks.timeline.pause();
    return missing;
  }

  // ── Names ───────────────────────────────────────────────────────────
  function kindNames(): Readonly<Record<string, string>> {
    const language = course.language.toLowerCase().split('-')[0];
    return KIND_NAMES[language] ?? KIND_NAMES.en;
  }

  post(ready());
  observeBlocks();
  flush(true);
}

// A field the reviewer types in: a letter there is text, not a shortcut.
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'].includes(target.type);
}

// The built-in kind of a block: its type, else the first built-in type of its lineage.
const BUILT_IN = ['heading', 'text', 'image', 'video', 'audio', 'quiz', 'numeric', 'decision', 'results', 'free-object', 'accordion', 'button', 'callout', 'math', 'stack'];
function kindOf(block: BlockData | undefined): string {
  if (!block) return 'component';
  return [block.type, ...(block.lineage ?? [])].find((type) => BUILT_IN.includes(type)) ?? 'component';
}

// The words a block is named by: its own label, a free object's frame title, an image's description
// or caption, its heading, a question's stem, else its first words; not those of the blocks in its
// slots. Forty characters at most, cut at a word.
function labelOf(node: HTMLElement): string | null {
  const own = (selector: string) => [...node.querySelectorAll<HTMLElement>(selector)].find((found) => found.closest('.t-block[data-block]') === node && !found.closest('.t-sr-only'));
  const candidates = [
    node.getAttribute('aria-label'),
    own('iframe')?.getAttribute('title'),
    own('img')?.getAttribute('alt'),
    own('figcaption')?.textContent,
    own('h1, h2, h3, h4, h5, h6, legend')?.textContent,
    own('[data-t-stem], [data-t-prompt]')?.textContent,
    ownText(node)
  ];
  for (const candidate of candidates) {
    const text = candidate?.replace(/\s+/g, ' ').trim();
    if (text) return shorten(text);
  }
  return null;
}
function ownText(node: HTMLElement): string {
  let text = '';
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (current) => current !== node && current instanceof HTMLElement && (current.matches('.t-block[data-block], .t-sr-only, script, style, [hidden], [aria-hidden="true"]')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  for (let current = walker.nextNode(); current && text.length < 120; current = walker.nextNode()) if (current.nodeType === Node.TEXT_NODE) text += ` ${current.textContent ?? ''}`;
  return text;
}
function shorten(text: string): string {
  if (text.length <= 40) return text;
  const cut = text.slice(0, 40);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?«»"“”'’-]+$/, '')}…`;
}

// Kinds of blocks, in the player's languages.
const KIND_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  fr: { heading: 'Titre', text: 'Texte', image: 'Image', video: 'Vidéo', audio: 'Audio', quiz: 'Quiz', numeric: 'Question numérique', decision: 'Décision', results: 'Résultats', 'free-object': 'Objet interactif', accordion: 'Accordéon', button: 'Bouton', callout: 'Encadré', math: 'Formule', stack: 'Pile', component: 'Bloc' },
  en: { heading: 'Heading', text: 'Text', image: 'Image', video: 'Video', audio: 'Audio', quiz: 'Quiz', numeric: 'Numeric question', decision: 'Decision', results: 'Results', 'free-object': 'Interactive object', accordion: 'Accordion', button: 'Button', callout: 'Callout', math: 'Formula', stack: 'Stack', component: 'Block' },
  de: { heading: 'Überschrift', text: 'Text', image: 'Bild', video: 'Video', audio: 'Audio', quiz: 'Quiz', numeric: 'Zahlenfrage', decision: 'Entscheidung', results: 'Ergebnisse', 'free-object': 'Interaktives Objekt', accordion: 'Akkordeon', button: 'Schaltfläche', callout: 'Hinweis', math: 'Formel', stack: 'Stapel', component: 'Block' },
  es: { heading: 'Título', text: 'Texto', image: 'Imagen', video: 'Vídeo', audio: 'Audio', quiz: 'Cuestionario', numeric: 'Pregunta numérica', decision: 'Decisión', results: 'Resultados', 'free-object': 'Objeto interactivo', accordion: 'Acordeón', button: 'Botón', callout: 'Recuadro', math: 'Fórmula', stack: 'Pila', component: 'Bloque' },
  it: { heading: 'Titolo', text: 'Testo', image: 'Immagine', video: 'Video', audio: 'Audio', quiz: 'Quiz', numeric: 'Domanda numerica', decision: 'Decisione', results: 'Risultati', 'free-object': 'Oggetto interattivo', accordion: 'Fisarmonica', button: 'Pulsante', callout: 'Riquadro', math: 'Formula', stack: 'Pila', component: 'Blocco' },
  nl: { heading: 'Titel', text: 'Tekst', image: 'Afbeelding', video: 'Video', audio: 'Audio', quiz: 'Quiz', numeric: 'Numerieke vraag', decision: 'Beslissing', results: 'Resultaten', 'free-object': 'Interactief object', accordion: 'Accordeon', button: 'Knop', callout: 'Kader', math: 'Formule', stack: 'Stapel', component: 'Blok' },
  pt: { heading: 'Título', text: 'Texto', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', quiz: 'Questionário', numeric: 'Pergunta numérica', decision: 'Decisão', results: 'Resultados', 'free-object': 'Objeto interativo', accordion: 'Acordeão', button: 'Botão', callout: 'Destaque', math: 'Fórmula', stack: 'Pilha', component: 'Bloco' }
};

// Last: the tables above are defined before the bridge reads them.
if (review && review.origins.length && window.parent !== window && hooks) startBridge(review.origins);
