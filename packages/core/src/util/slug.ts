// An id from a title (a course, a screen, a section): lowercase ASCII letters, digits and hyphens,
// starting with a letter (`fallback` before one that would not), at most `max` characters.
export function slugify(text: string, fallback: string, max = 40): string {
  const slug = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  if (!slug) return fallback;
  return /^[a-z]/.test(slug) ? slug : `${fallback}-${slug}`.slice(0, max).replace(/-+$/, '');
}
