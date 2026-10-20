const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Text for HTML content and attribute values (index.html, object frames, the SCORM manifest).
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
