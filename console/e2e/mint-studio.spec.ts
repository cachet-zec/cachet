import { expect, test } from "@playwright/test";

/**
 * The browser mint studio, end to end against a real regtest chain: a
 * seed born in the page mints an asset, scans the chain locally for its
 * notes, transfers to its own address, burns — every proof built in the
 * page's Web Worker, the server only relaying signed bytes.
 *
 * Three real Halo2 proofs happen here (mint, transfer, burn); on a
 * single-core CI runner that is minutes, hence the generous timeout.
 */
// On failure, put the page's own story in the CI log: visible errors,
// the current stage line, and the holdings state. Cheaper than
// downloading a trace to learn which step actually broke.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const story = await page
    .evaluate(() => {
      const lines = document.body.innerText.split("\n").map((line) => line.trim());
      const pick = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).slice(0, 4);
      return {
        errors: pick(/failed|error|unavailable|too many|mismatch|insufficient/i),
        stage: pick(/^(Sealing|Reading|Proving|Relaying|Updating|scanning block|synced to block)/),
        holdings: [...document.querySelectorAll("li[data-testid^='holding-']")].map((el) =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        ),
      };
    })
    .catch(() => null);
  console.log("[mint-studio failure state]", JSON.stringify(story));
});

test("browser mint, local scan, transfer and burn — keys never leave the page", async ({
  page,
}) => {
  test.setTimeout(1_500_000);
  const name = `Browser E2E ${Date.now().toString(16)}`;

  await page.goto("/mint");

  // --- A seed born in the page (read-only word grid), confirmed saved ---
  await page.getByRole("button", { name: "Generate a new seed" }).click();
  await expect(page.getByTestId("mint-seed-grid").locator("li")).toHaveCount(24);
  await page.getByTestId("mint-seed-saved").check();

  // --- Mint 5 units, reissuable (so the lifecycle isn't about sealing),
  //     with a sealed description — the community-metadata path ---
  const description = "Sealed by the browser e2e: description travels in the bundle.";
  await page.getByTestId("mint-name").fill(name);
  await page.getByTestId("mint-description").fill(description);
  await page.getByTestId("mint-amount").fill("5");
  await page.getByRole("switch").click(); // Seal at mint → Reissuable
  await page.getByTestId("mint-submit").click();
  const mintedAsset = page.getByTestId("mint-receipt-asset");
  await expect(mintedAsset, "browser proof + relay + mine").toBeVisible({ timeout: 300_000 });
  const assetId = (await mintedAsset.textContent())?.trim() ?? "";
  expect(assetId).toMatch(/^[0-9a-f]{64}$/);

  // --- Scan the chain locally: the holding appears ---
  await page.getByTestId("holdings-scan").click();
  const holding = page.getByTestId(`holding-${assetId.slice(0, 8)}`);
  await expect(holding).toBeVisible({ timeout: 120_000 });
  await expect(holding).toContainText("× 5");

  // --- Transfer 1 to our own address (a real shielded round trip) ---
  const address = (await page.getByTestId("wallet-address").textContent())?.trim() ?? "";
  expect(address).toMatch(/^u/);
  await holding.getByTestId("holding-transfer").click();
  await page.getByTestId("spend-recipient").fill(address);
  await page.getByTestId("spend-amount").fill("1");
  await page.getByTestId("spend-submit").click();
  await expect(page.getByTestId("spend-receipt")).toContainText("transferred", {
    timeout: 420_000,
  });
  // Self-transfer conserves the balance; the rescan must agree.
  await expect(holding).toContainText("× 5", { timeout: 120_000 });

  // --- Burn 2: supply drops on chain, holdings follow ---
  await holding.getByTestId("holding-burn").click();
  await page.getByTestId("spend-amount").fill("2");
  await page.getByTestId("spend-submit").click();
  await expect(page.getByTestId("spend-receipt")).toContainText("burned", { timeout: 420_000 });
  await expect(holding).toContainText("× 3", { timeout: 120_000 });

  // --- The public registry agrees: supply is 3 ---
  const response = await page.request.get(`http://localhost:8080/api/v1/assets/${assetId}`);
  expect(response.ok()).toBeTruthy();
  const asset = await response.json();
  expect(asset.total_supply).toBe(3);
  expect(asset.finalized).toBe(false);

  // --- The asset page renders the sealed description, hash-verified in
  //     the browser (navigation last: it wipes the in-memory seed) ---
  await page.goto(`/assets/${assetId}`);
  await expect(page.getByTestId("verification-badge")).toContainText("verified", {
    timeout: 60_000,
  });
  await expect(page.getByText(description)).toBeVisible();
});
