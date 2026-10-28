// The licences of the course's sounds (docs/decisions.md D67): what may ship in a course that is sold
// and whose sounds are cut, and the credit a licence asks for.

import type { Sound } from '@elabora/format';

export type LicenceKind = 'cc0' | 'public-domain' | 'by' | 'by-sa' | 'own' | 'generated';
export type LicenceRefusal = 'non-commercial' | 'no-derivatives' | 'unknown';
export type Licence = { ok: true; kind: LicenceKind; credit: boolean; name: string } | { ok: false; refusal: LicenceRefusal; name: string };

// An SPDX-like id read as people write it (« CC BY 4.0 », « cc-by-4.0 », « CC0 »).
export function classifyLicence(value: unknown): Licence {
  const name = typeof value === 'string' ? value.trim() : '';
  const id = name.toUpperCase().replace(/[\s_]+/g, '-');
  if (!id) return { ok: false, refusal: 'unknown', name };
  if (/(^|-)NC(-|$)/.test(id)) return { ok: false, refusal: 'non-commercial', name };
  if (/(^|-)ND(-|$)/.test(id)) return { ok: false, refusal: 'no-derivatives', name };
  if (/^CC0(-1\.0)?$/.test(id)) return { ok: true, kind: 'cc0', credit: false, name: 'CC0 1.0' };
  if (/^(PDM(-1\.0)?|PUBLIC-DOMAIN|PD)$/.test(id)) return { ok: true, kind: 'public-domain', credit: false, name: 'Public Domain' };
  const by = /^CC-BY(-SA)?(?:-(\d\.\d))?$/.exec(id);
  if (by) return { ok: true, kind: by[1] ? 'by-sa' : 'by', credit: true, name: `CC BY${by[1] ? '-SA' : ''}${by[2] ? ` ${by[2]}` : ''}` };
  if (id === 'OWN') return { ok: true, kind: 'own', credit: false, name: 'own' };
  if (id === 'GENERATED') return { ok: true, kind: 'generated', credit: false, name: 'generated' };
  return { ok: false, refusal: 'unknown', name };
}

const MODIFIED: Record<string, string> = { fr: 'modifié', en: 'modified', de: 'bearbeitet', es: 'modificado', it: 'modificato', nl: 'bewerkt', pt: 'modificado' };

// The credit line of a sound whose licence asks for one (CC BY, CC BY-SA): its sidecar's own, else
// « “Title”, Author — CC BY 4.0, modified — https://… »; null when none is owed.
export function soundCredit(sidecar: Sound | null, language: string): string | null {
  if (!sidecar) return null;
  const licence = classifyLicence(sidecar.license);
  if (!licence.ok || !licence.credit) return null;
  if (sidecar.credit) return sidecar.credit;
  const changed = sidecar.modified?.some((change) => change !== 'converted') ? `, ${MODIFIED[language.split('-')[0].toLowerCase()] ?? MODIFIED.en}` : '';
  const head = [sidecar.title ? `“${sidecar.title}”` : null, sidecar.author || null].filter(Boolean).join(', ');
  return [head || null, `${licence.name}${changed}`, sidecar.url ?? null].filter(Boolean).join(' — ');
}
