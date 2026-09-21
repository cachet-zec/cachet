import { execSync } from "node:child_process";

import { expect, test } from "@playwright/test";

/**
 * Minting a kept asset again, end to end on regtest: an asset minted from a
 * seed born in the page vanishes from the index, its page offers to mint it
 * again, a seed that did not mint it is refused, and the seed that did
 * brings the same asset id back.
 *
 * A test cannot reset a chain, so it stands in for one the way a reset
 * shows to the registry: the index no longer has the asset, the journal
 * still has its description. That takes one statement against the index
 * database; `CACHET_E2E_PSQL` says how to reach it (default: the compose
 * stack's container).
 */
const PSQL =
  process.env.CACHET_E2E_PSQL ?? "docker exec -i infra-postgres-1 psql -U cachet -d cachet";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwDiqEF8hAHbTA/1oCEbLAAAAAElFTkSuQmCC";

test("a kept asset comes back under the same id", async ({ page }) => {
  test.setTimeout(1_500_000);
  const name = `Remint Probe ${Date.now().toString(16)}`;
  const text = "Sealed text that must survive, to the character.";

  await page.goto("/mint");
  await page.getByRole("button", { name: "Generate a new seed" }).click();
  await expect(page.getByTestId("mint-seed-grid").locator("li")).toHaveCount(24);
  await page.getByTestId("mint-seed-reveal").click();
  await expect(page.getByTestId("mint-seed-reveal")).toHaveText("hide words");
  const phrase = (await page.getByTestId("mint-seed-grid").locator("li").allTextContents())
    .map((word) => word.replace(/^\s*\d+\s*/, "").trim())
    .join(" ");
  await page.getByTestId("mint-seed-saved").check();
  await page.getByTestId("mint-name").fill(name);
  await page.getByTestId("mint-description").fill(text);
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.getByTestId("mint-amount").fill("5");
  await page.getByRole("switch").click(); // reissuable: the chain still carries it
  await page.getByTestId("mint-submit").click();
  const minted = page.getByTestId("mint-receipt-asset");
  await expect(minted).toBeVisible({ timeout: 300_000 });
  const assetId = ((await minted.textContent()) ?? "").trim();
  expect(assetId).toMatch(/^[0-9a-f]{64}$/);

  // Stand in for a reset: the index forgets the asset, the journal does not.
  // The id is 64 hex characters, checked just above.
  const sql = `DELETE FROM asset_events WHERE asset_id = decode('${assetId}','hex'); DELETE FROM assets WHERE asset_id = decode('${assetId}','hex');`;
  execSync(`${PSQL} -q -c "${sql}"`);

  // The old link: kept content, checked, and the way back.
  await page.goto(`/assets/${assetId}`);
  const kept = page.getByTestId("kept-asset");
  await expect(kept).toBeVisible({ timeout: 30_000 });
  await expect(kept).toContainText(name);
  await expect(kept).toContainText(text);
  await expect(kept.locator("img")).toBeVisible();

  // The list on the continuity page shows kept assets (this regtest has
  // been reset many times, so ours may be pages away: ask the registry).
  await page.goto("/continuity");
  await expect(page.getByTestId("kept-list")).toBeVisible({ timeout: 30_000 });
  const listed = await page.request.get("http://localhost:8080/api/v1/kept?limit=100");
  expect(((await listed.json()) as { asset_id: string }[]).map((row) => row.asset_id)).toContain(
    assetId,
  );

  await page.goto(`/assets/${assetId}`);
  await page.getByTestId("kept-remint").click();
  await expect(page).toHaveURL(new RegExp(`/mint\\?remint=${assetId}`));
  await expect(page.getByTestId("remint-notice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("mint-name")).toHaveValue(name);
  await expect(page.getByTestId("mint-name")).toHaveAttribute("readonly", "");
  await expect(page.getByTestId("mint-description")).toHaveValue(text);
  await expect(page.getByTestId("remint-image")).toBeVisible();
  await expect(page.getByTestId("remint-match")).toContainText("Enter the seed");

  // A seed that did not mint it: said so, and the button stays shut.
  await page.getByRole("button", { name: "Generate a new seed" }).click();
  await page.getByTestId("mint-seed-saved").check();
  await expect(page.getByTestId("remint-match")).toContainText("Not the seed that minted it", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("mint-submit")).toBeDisabled();

  // The seed that did.
  await page.goto(`/mint?remint=${assetId}`);
  await expect(page.getByTestId("remint-notice")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "I already have one" }).click();
  await page.getByTestId("mint-seed").fill(phrase);
  await page.getByTestId("mint-seed-saved").check();
  await expect(page.getByTestId("remint-match")).toContainText(
    `Same asset id with this seed: ${assetId}`,
    { timeout: 30_000 },
  );
  await page.getByTestId("mint-amount").fill("3");
  await page.getByRole("switch").click();
  await page.getByTestId("mint-submit").click();
  const again = page.getByTestId("mint-receipt-asset");
  await expect(again).toBeVisible({ timeout: 300_000 });
  expect(((await again.textContent()) ?? "").trim()).toBe(assetId);

  // Back on chain: no longer "kept".
  const after = await page.request.get("http://localhost:8080/api/v1/kept?limit=100");
  expect(((await after.json()) as { asset_id: string }[]).map((row) => row.asset_id)).not.toContain(
    assetId,
  );
  const back = await page.request.get(`http://localhost:8080/api/v1/assets/${assetId}`);
  expect(back.status()).toBe(200);
});
