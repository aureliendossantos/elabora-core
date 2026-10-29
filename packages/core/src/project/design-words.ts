// How a named style or backdrop variant reads in the editor (schemas 0.1.6, designWords): its name
// and what it is for, in the course's language. The description alone is enough: the name is then
// its identifier, capitalised by whoever shows it. The identifier stays what screens, blocks and
// stylesheets use.
export interface DesignWordsRead {
  label: string | null;
  description: string;
}

export function designWords(value: unknown): DesignWordsRead {
  if (typeof value === 'string') return { label: null, description: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { label: null, description: '' };
  const { label, description } = value as Record<string, unknown>;
  return { label: typeof label === 'string' && label.trim() ? label : null, description: typeof description === 'string' ? description : '' };
}
