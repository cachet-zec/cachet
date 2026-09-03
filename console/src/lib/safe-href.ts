/**
 * URL fields inside metadata bundles are attacker-authored: the hash
 * checks prove integrity, not safety. A link
 * is only ever rendered for http(s) targets — `javascript:`, `data:` and
 * every other scheme come back as null and must render as plain text.
 */
export function safeExternalHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
