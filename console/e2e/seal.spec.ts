import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Sealing a supply without minting, end to end on regtest: an asset minted
 * open from a seed born in the page, sealed later by that seed alone with
 * an issuance of zero units, and the chain agreeing: supply unchanged,
 * finalized, and the decoded transaction saying exactly that.
 */
const API = "http://localhost:8080";

async function assetOnChain(request: APIRequestContext, assetId: string) {
  const response = await request.get(`${API}/api/v1/assets/${assetId}`);
  return response.ok()
    ? ((await response.json()) as { total_supply: number; finalized: boolean })
    : null;
}

test("an open supply is sealed by its issuer with no new units", async ({ page }) => {
  test.setTimeout(1_500_000);
  const name = `Seal Probe ${Date.now().toString(16)}`;

  // --- Mint 4 units, open supply, keeping the phrase ---
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
  await page.getByTestId("mint-amount").fill("4");
  await page.getByRole("switch").click(); // Seal at mint → Reissuable
  await page.getByTestId("mint-submit").click();
  const minted = page.getByTestId("mint-receipt-asset");
  await expect(minted).toBeVisible({ timeout: 300_000 });
  const assetId = ((await minted.textContent()) ?? "").trim();
  expect(assetId).toMatch(/^[0-9a-f]{64}$/);
  await expect
    .poll(async () => (await assetOnChain(page.request, assetId))?.total_supply ?? 0, {
      timeout: 120_000,
    })
    .toBe(4);

  // --- The asset page: open supply, a way to seal it ---
  await page.goto(`/assets/${assetId}`);
  await expect(page.getByTestId("supply-ledger")).toContainText("Open", { timeout: 30_000 });
  await page.getByTestId("seal-supply-link").click();
  await expect(page).toHaveURL(new RegExp(`/mint\\?seal=${assetId}`));
  await expect(page.getByTestId("seal-notice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("mint-name")).toHaveValue(name);
  await expect(page.getByTestId("mint-name")).toHaveAttribute("readonly", "");

  // A seed that did not issue it: said so, and the button stays shut.
  await page.getByRole("button", { name: "Generate a new seed" }).click();
  await page.getByTestId("mint-seed-saved").check();
  await expect(page.getByTestId("seal-match")).toContainText("Not the seed that issued", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("mint-submit")).toBeDisabled();

  // The seed that did.
  await page.goto(`/mint?seal=${assetId}`);
  await expect(page.getByTestId("seal-notice")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "I already have one" }).click();
  await page.getByTestId("mint-seed").fill(phrase);
  await page.getByTestId("mint-seed-saved").check();
  await expect(page.getByTestId("seal-match")).toContainText(`This seed issued it: ${assetId}`, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("mint-submit")).toHaveText("Seal the supply");
  await page.getByTestId("mint-submit").click();
  const sealed = page.getByTestId("mint-receipt-asset");
  await expect(sealed).toBeVisible({ timeout: 300_000 });
  expect(((await sealed.textContent()) ?? "").trim()).toBe(assetId);
  await expect(page.getByText("supply sealed under your key")).toBeVisible();

  // --- The chain agrees: finalized, same supply ---
  await expect
    .poll(async () => (await assetOnChain(page.request, assetId))?.finalized ?? false, {
      timeout: 120_000,
    })
    .toBe(true);
  expect((await assetOnChain(page.request, assetId))?.total_supply).toBe(4);

  // --- The page says so, and the seal decodes to what it is ---
  await page.goto(`/assets/${assetId}`);
  await expect(page.getByTestId("sealed-stamp")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("supply-ledger")).toContainText("Sealed");
  await expect(page.getByTestId("supply-ledger")).toContainText("4");
  await expect(page.getByTestId("seal-supply-link")).toHaveCount(0);
  // Newest first: the seal is the top event.
  await page.getByRole("link", { name: "Decode" }).first().click();
  await expect(page).toHaveURL(/\/tx\/[0-9a-f]{64}$/);
  await expect(page.getByText("Sealed, no new units")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("supply sealed", { exact: true })).toBeVisible();
});
