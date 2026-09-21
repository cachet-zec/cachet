/**
 * The name an asset page shows, read from the on-chain description in the
 * browser instead of taken from the registry's `display_name`.
 *
 * The page checks that the description derives the asset id, so a name
 * read out of that description is covered by the check; a name field sent
 * alongside it is not, and a registry could put anything there. Mirrors
 * `display_name_for` in server/crates/domain.
 */

const MAX_LABEL_CHARS = 120;

// Control characters and bidirectional overrides: attacker-authored text.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

function clean(text: string): string {
  return [...text.trim().replace(UNSAFE, "")].slice(0, MAX_LABEL_CHARS).join("").trim();
}

export type SealedName =
  { name: string; source: "envelope" | "free_text" } | { name: null; source: null };

export function sealedName(description: string | null | undefined): SealedName {
  if (!description) return { name: null, source: null };
  try {
    const parsed: unknown = JSON.parse(description);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const fields = parsed as { v?: unknown; name?: unknown; sha256?: unknown };
      if (typeof fields.name === "string") {
        const name = clean(fields.name);
        if (name) {
          const sealed =
            fields.v === 1 && typeof fields.sha256 === "string" && fields.sha256.length === 64;
          return { name, source: sealed ? "envelope" : "free_text" };
        }
      }
    }
  } catch {
    // not JSON: a plain free-text label
  }
  // Nothing left once cleaned (only control or direction characters): say so
  // rather than render them.
  return { name: clean(description) || "(unnamed)", source: "free_text" };
}

/** A sealed image is shown only in the four formats the registry accepts. */
export function safeImageDataUri(uri: string | null | undefined): string | null {
  return uri && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(uri) ? uri : null;
}
