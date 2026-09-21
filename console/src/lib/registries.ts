/**
 * The registries this console can read, and the one the visitor picked.
 * An asset page checks the name, text and image itself whoever serves them;
 * lists, supplies and history remain the registry's own reading of the chain.
 * The list is fixed at build time (NEXT_PUBLIC_CACHET_REGISTRIES) so the
 * CSP stays a short list of known origins: that is what protects the seed.
 * Listing a registry is therefore trust in its OPERATOR, not in its data:
 * an injected script could send a seed to any origin the CSP allows.
 */

export const DEFAULT_REGISTRY = process.env.NEXT_PUBLIC_CACHET_API_URL ?? "http://localhost:8080";

export const REGISTRY_STORAGE_KEY = "cachet-registry";

function origins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      try {
        const url = new URL(entry);
        // Plain http only for local development.
        const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        return url.protocol === "https:" || (url.protocol === "http:" && local) ? [url.origin] : [];
      } catch {
        return [];
      }
    });
}

export const REGISTRIES: readonly string[] = [
  ...new Set([DEFAULT_REGISTRY, ...origins(process.env.NEXT_PUBLIC_CACHET_REGISTRIES)]),
];

/** The registry to read from: the stored choice if still listed, else the default. */
export function chosenRegistry(): string {
  if (typeof window === "undefined") return DEFAULT_REGISTRY;
  try {
    const stored = window.localStorage.getItem(REGISTRY_STORAGE_KEY);
    return stored && REGISTRIES.includes(stored) ? stored : DEFAULT_REGISTRY;
  } catch {
    return DEFAULT_REGISTRY; // storage unavailable (private mode)
  }
}
