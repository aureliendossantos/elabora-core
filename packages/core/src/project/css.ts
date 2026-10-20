// Light CSS reading for theme and layout stylesheets (no full parser: enough to find the files a
// stylesheet needs and the patterns the validator reports).

const stripComments = (css: string | null | undefined): string => String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');

// url(...) targets, without data: URIs and fragments.
export function cssUrls(css: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of stripComments(css).matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const u = m[2].trim();
    if (!u || u.startsWith('data:') || u.startsWith('#')) continue;
    out.push(u);
  }
  return out;
}

export function cssImports(css: string | null | undefined): string[] {
  return [...stripComments(css).matchAll(/@import\s+([^;]+);/gi)].map((m) => m[1].trim());
}

export const isExternalUrl = (u: string): boolean => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u) && !u.startsWith('data:');

// Hex colours written outside custom property declarations (--x: #fff is fine: it names a value).
export function literalColors(css: string | null | undefined): string[] {
  const out: string[] = [];
  for (const decl of stripComments(css).replace(/[{}]/g, ';').split(';')) {
    const d = decl.trim();
    if (!d || d.startsWith('--') || d.startsWith('@')) continue;
    const i = d.indexOf(':');
    if (i < 0) continue;
    // Masks read only the alpha of their colours: #000 in a mask gradient is not a colour of the charter.
    if (/^(-webkit-)?mask(-image|-border(-source)?)?$/i.test(d.slice(0, i).trim())) continue;
    for (const m of d.slice(i + 1).matchAll(/#[0-9a-f]{3,8}\b/gi)) out.push(m[0]);
  }
  return out;
}

// content: "…" with letters: text in CSS cannot be translated or edited by authors.
// Font sizes in px do not follow the size classes of the player (1rem follows the window).
export function fixedFontSizes(css: string | null | undefined): string[] {
  const out: string[] = [];
  for (const decl of stripComments(css).replace(/[{}]/g, ';').split(';')) {
    const m = decl.trim().match(/^(font-size|font)\s*:(.*)$/i);
    if (!m) continue;
    for (const px of m[2].matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)) if (Number(px[1]) > 0) out.push(`${m[1]}: ${px[0]}`);
  }
  return out;
}

export function cssTextContents(css: string | null | undefined): string[] {
  return [...stripComments(css).matchAll(/content\s*:\s*(['"])(.*?)\1/gi)].map((m) => m[2]).filter((t) => /\p{L}{2,}/u.test(t));
}

export { stripComments };
