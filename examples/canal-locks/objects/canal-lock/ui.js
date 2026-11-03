// The object's own interface: the controls and notes in the scene, the hint, the tool bar and the
// bubble of the explanation. It follows the course theme through the --t-* variables, sizes in rem.
// Things placed over the scene move with the CSS `translate` property, so their own animations
// (a shake, a pulse) can use `transform` without losing their place.
export const STYLE = `
.cl-root{position:absolute;inset:0;overflow:hidden;font:1rem/1.45 var(--t-font-body,system-ui,sans-serif);color:var(--t-text)}
.cl-root *{box-sizing:border-box}
.cl-root [hidden]{display:none!important}
.cl-root.is-narrow{position:static;overflow:visible;display:flex;flex-direction:column}
.cl-stage{position:absolute;inset:0}
.is-narrow .cl-stage{position:relative;inset:auto;flex:none}
.cl-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}
.cl-root.is-fading canvas{opacity:0;transition:opacity .6s ease}
.cl-root.is-fading.is-in canvas{opacity:1}
.cl-anno{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.cl-anno .lead{stroke:color-mix(in srgb,var(--t-text) 45%,transparent);stroke-width:1.2;fill:none}
.cl-anno .dot{fill:var(--t-surface);stroke:var(--t-text);stroke-width:1.4}
.cl-anno .dot.is-open{fill:var(--t-color-water,var(--t-primary))}
.cl-anno .flow{fill:none;stroke:var(--t-color-water-deep,var(--t-primary));stroke-width:2.4;stroke-linecap:round;stroke-dasharray:2 9}
.cl-anno .flow-head{fill:var(--t-color-water-deep,var(--t-primary))}
.cl-anno .target{fill:none;stroke:var(--t-color-water-deep,var(--t-primary));stroke-width:1.5;stroke-dasharray:6 5;opacity:.85}
.cl-anno .dim{fill:none;stroke:var(--t-accent);stroke-width:1.5}
.cl-anno .dim.is-equal{stroke:var(--t-success)}
.cl-anno g{transition:opacity .35s ease}
.cl-labels{position:absolute;inset:0;pointer-events:none}
.cl-labels,.cl-anno,.cl-hotspots,.cl-panel,.cl-bubble{transition:opacity .6s ease}
.is-revealing .cl-labels,.is-revealing .cl-anno,.is-revealing .cl-hotspots,.is-revealing .cl-panel,.is-revealing .cl-bubble{opacity:0}
.is-passing .cl-labels,.is-passing .cl-anno,.is-passing .cl-hotspots,.is-passing .cl-panel,.is-passing .cl-bubble{opacity:0;transition:none}
.cl-label{position:absolute;left:0;top:0;white-space:nowrap;font:italic 500 0.875rem/1.2 var(--t-font-heading,serif);color:var(--t-text);text-shadow:0 0 3px var(--t-surface),0 0 6px var(--t-surface),0 0 10px var(--t-surface);transition:opacity .35s ease;opacity:0}
.cl-label.is-on{opacity:1}
.cl-label.is-tech{font:600 0.8125rem/1.2 var(--t-font-body,sans-serif);font-style:normal;font-variant-numeric:tabular-nums}
.cl-label.is-dim{color:var(--t-accent);font:700 0.8125rem/1 var(--t-font-body,sans-serif);font-style:normal;font-variant-numeric:tabular-nums}
.cl-label.is-dim.is-equal{color:var(--t-success)}

/* Controls in the scene: the part's name, and its state underneath, coloured by the state. */
.cl-hotspots{position:absolute;inset:0;pointer-events:none}
.cl-hot{position:absolute;left:0;top:0;pointer-events:auto;display:inline-flex;align-items:center;gap:.5rem;min-height:44px;padding:.3125rem 1rem;border-radius:999px;border:1px solid color-mix(in srgb,var(--t-text) 16%,transparent);background:color-mix(in srgb,var(--t-surface) 95%,transparent);color:var(--t-text);font:600 .875rem/1.1 var(--t-font-body,sans-serif);text-align:left;box-shadow:0 1px 2px color-mix(in srgb,var(--t-text) 10%,transparent),0 6px 18px color-mix(in srgb,var(--t-text) 10%,transparent);cursor:pointer;white-space:nowrap;transition:border-color .2s ease,box-shadow .2s ease}
button.cl-hot:hover{border-color:var(--t-primary)}
.cl-hot-text{display:flex;flex-direction:column;gap:.1875rem}
.cl-hot-state{font:600 .75rem/1 var(--t-font-body,sans-serif);letter-spacing:.01em;color:var(--t-color-terracotta,var(--t-accent));transition:color .35s ease}
.cl-hot.is-open .cl-hot-state{color:var(--t-color-water-deep,var(--t-primary))}
.cl-hot.is-moving .cl-hot-state{animation:cl-breathe 1.1s ease-in-out infinite}
.cl-hot--boat{gap:.3125rem;padding:.25rem .3125rem .25rem 1rem;cursor:default}
.cl-hot--boat .cl-hot-name{margin-right:.25rem}
.cl-round{flex:none;display:grid;place-items:center;width:2.25rem;height:2.25rem;padding:0;border-radius:50%;border:1px solid color-mix(in srgb,var(--t-text) 20%,transparent);background:var(--t-surface);color:var(--t-text);cursor:pointer;transition:background-color .25s ease,border-color .25s ease,color .25s ease}
.cl-round svg{width:1.125rem;height:1.125rem}
.cl-round:hover{border-color:var(--t-primary)}
.cl-round.is-main,.cl-round.is-ready{background:var(--t-primary);border-color:var(--t-primary);color:var(--t-on-primary)}
.cl-round[aria-disabled=true]{opacity:.4;cursor:default}
.cl-round[aria-disabled=true]:hover{border-color:color-mix(in srgb,var(--t-text) 20%,transparent)}
.cl-round.is-main[aria-disabled=true]{background:var(--t-surface);border-color:color-mix(in srgb,var(--t-text) 20%,transparent);color:var(--t-text)}
.cl-dir svg{transform:rotate(var(--cl-dir,0deg));transition:transform .4s ease}
.cl-dir.is-back svg{transform:rotate(calc(var(--cl-dir,0deg) + 180deg))}
.cl-hot.is-suggested{border-color:var(--t-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--t-accent) 35%,transparent),0 6px 18px color-mix(in srgb,var(--t-text) 10%,transparent);animation:cl-pulse 1.6s ease-in-out infinite}
.cl-hot.is-refused{border-color:var(--t-accent);animation:cl-shake .45s ease-in-out}
@keyframes cl-pulse{50%{box-shadow:0 0 0 7px color-mix(in srgb,var(--t-accent) 18%,transparent),0 6px 18px color-mix(in srgb,var(--t-text) 10%,transparent)}}
@keyframes cl-shake{20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(2px)}}
@keyframes cl-breathe{50%{opacity:.55}}
@keyframes cl-in{from{opacity:0;transform:translateY(4px)}}
.cl-root :focus-visible{outline:3px solid var(--t-focus);outline-offset:2px}

/* The explanation: one bubble in the scene, pointing at what moves. */
.cl-bubble{position:absolute;left:0;top:0;z-index:2;width:min(25.5rem,calc(100% - 2rem));padding:.875rem 1rem .625rem 1.125rem;border-radius:1rem;background:color-mix(in srgb,var(--t-surface) 97%,transparent);border:1px solid color-mix(in srgb,var(--t-text) 10%,transparent);box-shadow:0 1px 2px color-mix(in srgb,var(--t-text) 8%,transparent),0 12px 32px color-mix(in srgb,var(--t-text) 12%,transparent)}
.cl-bubble-body.is-new{animation:cl-in .45s ease both}
.cl-bubble-title{margin:0 0 .25rem;font:600 1.125rem/1.2 var(--t-font-heading,serif);letter-spacing:-.005em}
.cl-bubble-text{margin:0;font-size:.9375rem;line-height:1.48}
.cl-bubble-nav{display:flex;align-items:center;gap:.375rem;margin-top:.625rem}
.cl-bubble-nav .is-replay{margin-right:auto;border-color:transparent;background:transparent;color:var(--t-muted)}
.cl-bubble-nav .is-replay:hover{border-color:color-mix(in srgb,var(--t-text) 20%,transparent);color:var(--t-text)}

.cl-pause{position:absolute;top:.75rem;right:.75rem;width:44px;height:44px;border-radius:50%;border:1px solid color-mix(in srgb,var(--t-text) 18%,transparent);background:color-mix(in srgb,var(--t-surface) 88%,transparent);color:var(--t-text);display:grid;place-items:center;cursor:pointer;z-index:3}
.cl-pause svg,.cl-tool svg{width:1.125rem;height:1.125rem}
.cl-panel{position:absolute;left:var(--cl-left,1rem);right:var(--cl-right,1rem);bottom:1rem;display:flex;align-items:flex-end;justify-content:flex-end;gap:1rem;pointer-events:none;z-index:2}
.cl-panel>*{pointer-events:auto}
.is-narrow .cl-panel{position:static;flex-direction:column;align-items:stretch;padding:.75rem 0 0;gap:.75rem}
.cl-side{display:flex;flex-direction:column;align-items:flex-end;gap:.625rem}
.is-narrow .cl-side{align-items:stretch}

/* The hint opens above the tool bar. */
.cl-hint{position:relative;max-width:22rem;margin:0;padding:.6875rem 2.75rem .75rem 1rem;border-radius:.875rem;background:color-mix(in srgb,var(--t-accent) 8%,var(--t-surface));border:1px solid color-mix(in srgb,var(--t-accent) 30%,transparent);box-shadow:0 1px 2px color-mix(in srgb,var(--t-text) 8%,transparent),0 10px 26px color-mix(in srgb,var(--t-text) 10%,transparent);animation:cl-in .3s ease both}
.is-narrow .cl-hint{max-width:none}
.cl-hint small{display:block;margin-bottom:.125rem;font:700 0.75rem/1.2 var(--t-font-body,sans-serif);letter-spacing:.04em;color:var(--t-muted)}
.cl-hint p{margin:0;font-size:.9375rem;line-height:1.42}
.cl-hint .cl-round{position:absolute;top:.375rem;right:.375rem;width:2rem;height:2rem;border-color:transparent;background:transparent;color:var(--t-muted)}
.cl-hint .cl-round svg{width:1rem;height:1rem}

.cl-tools{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:.5rem}
.is-narrow .cl-tools{justify-content:flex-start}
.cl-tool{display:inline-flex;align-items:center;gap:.4375rem;min-height:44px;min-width:44px;padding:0 .875rem;border-radius:999px;border:1px solid color-mix(in srgb,var(--t-text) 20%,transparent);background:color-mix(in srgb,var(--t-surface) 92%,transparent);color:var(--t-text);font:600 0.9375rem/1 var(--t-font-body,sans-serif);cursor:pointer}
.cl-tool:hover{border-color:var(--t-primary)}
.cl-tool[aria-pressed=false]{color:var(--t-muted)}
.cl-tool[aria-expanded=true]{border-color:var(--t-accent)}
.cl-seg{display:inline-flex;padding:3px;border-radius:999px;border:1px solid color-mix(in srgb,var(--t-text) 20%,transparent);background:color-mix(in srgb,var(--t-surface) 92%,transparent)}
.cl-seg button{min-height:38px;min-width:44px;padding:0 .75rem;border:0;border-radius:999px;background:transparent;color:var(--t-text);font:600 0.875rem/1 var(--t-font-body,sans-serif);cursor:pointer}
.cl-seg button[aria-pressed=true]{background:var(--t-text);color:var(--t-surface)}
.cl-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.is-narrow .cl-hotspots{position:static;display:grid;grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr));gap:.5rem;pointer-events:auto}
.is-narrow .cl-hot{position:static;translate:none!important}
.is-narrow .cl-hot--boat{grid-column:1/-1;justify-self:start}
.is-narrow .cl-bubble{position:relative;translate:none!important;width:auto;margin-top:.75rem}
@media (prefers-reduced-motion: reduce){.cl-hot.is-suggested,.cl-hot.is-refused,.cl-hot.is-moving .cl-hot-state,.cl-bubble-body.is-new,.cl-hint{animation:none}.cl-root.is-fading canvas,.cl-dir svg{transition:none}}
`;

const svg = (body, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICON = {
  pause: svg('<path d="M9 5v14M15 5v14"/>'),
  play: svg('<path d="M8 5l11 7-11 7z" fill="currentColor"/>'),
  hint: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  sound: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  muted: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>'),
  prev: svg('<path d="M15 18l-6-6 6-6"/>'),
  next: svg('<path d="M9 18l6-6-6-6"/>'),
  replay: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  arrow: svg('<path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5"/>')
};

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
export function button(cls, label) {
  const b = el('button', cls);
  b.type = 'button';
  if (label !== undefined) b.textContent = label;
  return b;
}
