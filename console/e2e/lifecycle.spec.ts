import { expect, test } from "@playwright/test";

/**
 * The full asset lifecycle through the UI, against a real OrchardZSA
 * regtest chain: issue → appears in the registry → transfer → burn →
 * supply reflects the burn.
 *
 * Each run uses a unique description, so the test tolerates a used chain.
 * Every on-chain step builds real proofs and mines a real block.
 */
test("issue, list, transfer, burn — full lifecycle on regtest", async ({ page }) => {
  const name = `E2E Lifecycle ${Date.now().toString(16)}`;

  await page.goto("/console");
  await expect(page.getByTestId("issue-submit")).toBeEnabled();

  // --- Issue 1000 units (registers a metadata bundle, then issues) ---
  await page.getByTestId("issue-name").fill(name);
  await page.getByTestId("issue-long-description").fill("Created by the Playwright e2e suite.");
  await page.getByTestId("issue-amount").fill("1000");
  await page.getByTestId("issue-submit").click();

  const receipt = page.getByTestId("issue-receipt-asset-id");
  await expect(receipt, "issuance builds a proof and mines a block").toBeVisible({
    timeout: 300_000,
  });
  const assetId = (await receipt.textContent())?.trim() ?? "";
  expect(assetId).toMatch(/^[0-9a-f]{64}$/);

  // --- The registry lists it, with its metadata display name ---
  const row = page.getByTestId(`asset-row-${assetId}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(name);
  // Supplies render with en-US thousands separators.
  await expect(row).toContainText("1,000");

  // --- Transfer 300 to the wallet's second account ---
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-asset-id").fill(assetId);
  await page.getByTestId("manage-amount").fill("300");
  await page.getByTestId("manage-recipient").fill("account:1");
  await page.getByTestId("transfer-submit").click();
  await expect(page.getByTestId("manage-result")).toContainText("Transfer accepted", {
    timeout: 300_000,
  });

  // --- Burn 200 from the issuer's change (two-click confirm) ---
  await page.getByTestId("manage-amount").fill("200");
  await page.getByTestId("burn-submit").click();
  await expect(page.getByTestId("burn-submit")).toContainText("Confirm");
  await page.getByTestId("burn-submit").click();
  await expect(page.getByTestId("manage-result")).toContainText("Burn accepted", {
    timeout: 300_000,
  });

  // --- Supply reflects the burn (1000 - 200), not the transfer ---
  await page.getByTestId("tab-lookup").click();
  await page.getByTestId("lookup-asset-id").fill(assetId);
  await page.getByTestId("lookup-submit").click();
  await expect(page.getByTestId("lookup-supply")).toHaveText("800");
});
