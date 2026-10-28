// UI kit available inside free-object frames: the same look as the player, driven by the
// --t-* variables of the course theme. Objects opt in with the t-ui-* classes (docs/free-object-contract.md).
export const OBJECT_UI_CSS = `
.t-ui{font:0.9375rem/1.45 var(--t-font-body,system-ui,sans-serif);color:var(--t-text,#1f2933)}
.t-ui *,.t-ui *::before,.t-ui *::after{box-sizing:border-box}
.t-ui-panel{display:flex;flex-direction:column;gap:0.625rem;padding:0.75rem 0.875rem;background:var(--t-surface,#fff);overflow:auto;overscroll-behavior:none}
.t-ui-title{margin:0;font:700 1.0625rem/1.3 var(--t-font-heading,inherit)}
.t-ui-eyebrow{margin:0;font-size:0.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--t-muted)}
.t-ui-muted{color:var(--t-muted)}
.t-ui-card{padding:0.625rem 0.75rem;border-radius:var(--t-radius,8px);background:color-mix(in srgb,var(--t-primary) 7%,var(--t-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--t-primary) 12%,transparent)}
.t-ui-card p{margin:0}
.t-ui-btn{display:inline-flex;align-items:center;justify-content:center;gap:0.375rem;min-height:44px;min-width:44px;padding:0 1rem;border-radius:var(--t-radius,8px);border:2px solid var(--t-primary);background:var(--t-surface);color:var(--t-primary);font:600 0.9375rem var(--t-font-body,inherit);cursor:pointer}
.t-ui-btn--primary{background:var(--t-primary);color:var(--t-on-primary)}
.t-ui-btn--ghost{border-color:transparent;background:transparent;color:inherit}
.t-ui-btn:disabled,.t-ui-btn[aria-disabled=true]{opacity:.55;cursor:not-allowed}
.t-ui-seg{border:0;margin:0;padding:0;min-width:0}
.t-ui-seg>legend{padding:0;margin:0 0 0.25rem;font-weight:700;font-size:0.875rem}
.t-ui-seg-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:0.25rem}
.t-ui-seg label{position:relative;display:flex;align-items:center;justify-content:center;min-height:40px;padding:0 0.375rem;border-radius:var(--t-radius,8px);border:2px solid color-mix(in srgb,var(--t-primary) 30%,var(--t-surface));font-weight:600;text-align:center;cursor:pointer}
.t-ui-seg input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.t-ui-seg label:has(input:checked){background:var(--t-primary);border-color:var(--t-primary);color:var(--t-on-primary)}
.t-ui-seg label:has(input:disabled){opacity:.45;cursor:not-allowed}
.t-ui-seg label:has(input:focus-visible){outline:3px solid var(--t-focus);outline-offset:2px}
.t-ui-meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:0.375rem}
.t-ui-meter{padding:0.4375rem 0.625rem;border-radius:var(--t-radius,8px);background:color-mix(in srgb,var(--t-text) 5%,var(--t-surface))}
.t-ui-meter small{display:block;font-size:0.6875rem;letter-spacing:.06em;text-transform:uppercase;color:var(--t-muted)}
.t-ui-meter b{display:block;font:700 1.1875rem/1.25 var(--t-font-heading,inherit);font-variant-numeric:tabular-nums}
.t-ui-meter em{display:block;font-style:normal;font-size:0.75rem;color:var(--t-muted)}
.t-ui-status{margin:0;min-height:1.4em}
.t-ui-status.is-ok{color:var(--t-success);font-weight:600}
.t-ui-status.is-ko{color:var(--t-error)}
.t-ui-badge{display:inline-block;padding:0.1875rem 0.5rem;border-radius:999px;font:700 0.6875rem/1.2 var(--t-font-body,inherit);letter-spacing:.06em;text-transform:uppercase;color:#fff;background:var(--t-primary)}
.t-ui :focus-visible{outline:3px solid var(--t-focus);outline-offset:2px}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
`;
