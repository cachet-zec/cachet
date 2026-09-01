/**
 * Typed client for the Cachet API.
 *
 * `schema.ts` is generated from the server's OpenAPI document
 * (`pnpm openapi:export && pnpm openapi:generate` from the repo root).
 * This module only adds the thin runtime wrapper; no endpoint or type is
 * ever declared by hand.
 */
import createClient from "openapi-fetch";

import type { paths } from "./generated/schema";

export type CachetClient = ReturnType<typeof createClient<paths>>;

export interface CachetClientOptions {
  /** Base URL of the Cachet server, e.g. `http://localhost:8080`. */
  baseUrl: string;
}

export function createCachetClient({ baseUrl }: CachetClientOptions): CachetClient {
  return createClient<paths>({ baseUrl });
}

export type { paths } from "./generated/schema";
