import { createCachetClient } from "@cachet/api-client";

import { chosenRegistry } from "@/lib/registries";

/**
 * Single client instance for the browser. The base URL is the registry the
 * visitor picked among the ones this build knows (lib/registries.ts), or
 * the build's default: the local dev server from docker-compose/SETUP.md
 * unless NEXT_PUBLIC_CACHET_API_URL says otherwise. Server-side rendering
 * always reads the default.
 */
export const apiBaseUrl = chosenRegistry();

export const api = createCachetClient({ baseUrl: apiBaseUrl });

/** Extract a human-readable message from an RFC 9457 problem response. */
export function problemMessage(problem: unknown): string {
  if (
    typeof problem === "object" &&
    problem !== null &&
    "detail" in problem &&
    typeof problem.detail === "string"
  ) {
    return problem.detail;
  }
  return "Unexpected error. Is the Cachet server running?";
}
