import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests of the full stack: console → cachet-server → OrchardZSA
 * regtest node. Prerequisites (documented in docs/SETUP.md):
 *   - the regtest node and Postgres are up:
 *     `docker compose -f infra/docker-compose.yml up -d`
 *   - Sapling params are installed.
 * Playwright starts (or reuses) the Cachet server and the console itself.
 *
 * Real Halo2 proving happens in these tests, so timeouts are generous.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  // The chain is a shared mutable resource: one worker, no parallelism.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "cargo run --manifest-path ../server/Cargo.toml --bin cachet-server",
      port: 8080,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: { CACHET_BACKEND: "zsa" },
    },
    {
      command: "pnpm dev",
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
