import { createCachetClient } from "@cachet/api-client";

/**
 * Single client instance for the browser. The base URL is inlined at build
 * time; defaults to the local dev server from docker-compose/SETUP.md.
 */
export const apiBaseUrl = process.env.NEXT_PUBLIC_CACHET_API_URL ?? "http://localhost:8080";

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
