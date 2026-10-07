import { expect, test, type Page } from "@playwright/test";

/**
 * An atomic swap between two browsers, end to end on regtest: each page
 * holds its own seed and mints its own asset; the maker parks units in a
 * swap slot and writes an offer; the taker builds, proves and signs the
 * whole swap; the maker checks and countersigns; the taker relays. One
 * transaction moves both assets, and each side's local scan sees exactly
 * what the offer said.
 */
async function mintWithPhrase(
  page: Page,
  name: string,
  amount: number,
): Promise<{ assetId: string; phrase: string }> {
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
  await page.getByTestId("mint-amount").fill(String(amount));
  await page.getByTestId("mint-submit").click();
  const minted = page.getByTestId("mint-receipt-asset");
  await expect(minted).toBeVisible({ timeout: 300_000 });
  const assetId = ((await minted.textContent()) ?? "").trim();
  expect(assetId).toMatch(/^[0-9a-f]{64}$/);
  return { assetId, phrase };
}

async function mint(page: Page, name: string, amount: number): Promise<string> {
  return (await mintWithPhrase(page, name, amount)).assetId;
}

/** Move between the pages that use keys the way a visitor does: through
 * the header, so the seed held in memory comes along. */
async function open(page: Page, name: "Mint" | "Swaps") {
  await page.locator("header").getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(name === "Mint" ? /\/mint/ : /\/swaps/);
}

async function holding(page: Page, assetId: string) {
  if (!new URL(page.url()).pathname.startsWith("/mint")) await open(page, "Mint");
  await page.getByTestId("holdings-scan").click();
  return page.getByTestId(`holding-${assetId.slice(0, 8)}`);
}

test("two browsers swap two assets in one transaction", async ({ browser }) => {
  test.setTimeout(2_400_000);
  const tag = Date.now().toString(16);
  const maker = await (await browser.newContext()).newPage();
  const taker = await (await browser.newContext()).newPage();

  const gold = await mint(maker, `Swap Gold ${tag}`, 10);
  const silver = await mint(taker, `Swap Silver ${tag}`, 20);

  // --- The maker parks 4 GOLD and asks 7 SILVER for them ---
  await open(maker, "Swaps");
  await open(taker, "Swaps");
  const makerSwap = maker.getByTestId("swap-panel");
  await makerSwap.getByRole("button", { name: "Scan my holdings" }).click();
  await expect(makerSwap.getByTestId("swap-give-asset").locator("option")).toHaveCount(2, {
    timeout: 120_000,
  });
  await makerSwap.getByTestId("swap-give-asset").selectOption(gold);
  await makerSwap.getByTestId("swap-give-amount").fill("4");
  await makerSwap.getByTestId("swap-want-asset").fill(silver);
  await makerSwap.getByTestId("swap-want-amount").fill("7");
  await makerSwap.getByTestId("swap-list-on-board").uncheck(); // by hand this time
  await makerSwap.getByTestId("swap-prepare").click();
  const offerOut = makerSwap.getByTestId("swap-offer-out");
  await expect(offerOut, "move to the slot, block, offer").toBeVisible({ timeout: 420_000 });
  const offer = await offerOut.inputValue();

  // --- The taker reads it, builds and signs its side ---
  const takerSwap = taker.getByTestId("swap-panel");
  await takerSwap.getByTestId("swap-role-take").click();
  await takerSwap.getByTestId("swap-offer-in").fill(offer);
  await expect(takerSwap.getByTestId("swap-offer-summary")).toContainText("4");
  await expect(takerSwap.getByTestId("swap-offer-summary")).toContainText("7");
  await takerSwap.getByTestId("swap-take").click();
  const answerOut = takerSwap.getByTestId("swap-answer-out");
  await expect(answerOut, "whole-swap proof").toBeVisible({ timeout: 420_000 });
  const answer = await answerOut.inputValue();

  // --- The maker checks it and countersigns ---
  await makerSwap.getByTestId("swap-answer-in").fill(answer);
  await makerSwap.getByTestId("swap-countersign").click();
  const signatureOut = makerSwap.getByTestId("swap-signature-out");
  await expect(signatureOut).toBeVisible({ timeout: 60_000 });
  const signature = await signatureOut.inputValue();

  // --- The taker completes and relays: one transaction ---
  await takerSwap.getByTestId("swap-signature-in").fill(signature);
  await takerSwap.getByTestId("swap-finish").click();
  await expect(takerSwap.getByTestId("swap-done")).toBeVisible({ timeout: 300_000 });
  await expect(takerSwap.getByTestId("swap-error")).toHaveCount(0);

  // --- The decoded transaction: no issuance, no burn, shielded actions ---
  await takerSwap.getByTestId("swap-done").getByRole("link").click();
  await expect(taker.getByText("This transaction issues nothing.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(taker.getByText("This transaction burns nothing.")).toBeVisible();

  // --- Each side's own scan agrees with the offer ---
  await expect(await holding(taker, gold)).toContainText("× 4", { timeout: 120_000 });
  await expect(await holding(taker, silver)).toContainText("× 13", { timeout: 120_000 });
  await expect(await holding(maker, silver)).toContainText("× 7", { timeout: 120_000 });
  await expect(await holding(maker, gold)).toContainText("× 6", { timeout: 120_000 });
});

test("a swap through the public board, with nothing passed by hand", async ({ browser }) => {
  test.setTimeout(2_400_000);
  const tag = Date.now().toString(16);
  const maker = await (await browser.newContext()).newPage();
  const taker = await (await browser.newContext()).newPage();

  const gold = await mint(maker, `Board Gold ${tag}`, 9);
  const { assetId: silver, phrase } = await mintWithPhrase(taker, `Board Silver ${tag}`, 15);

  // --- The maker lists 3 GOLD for 5 SILVER (listing is the default) ---
  await open(maker, "Swaps");
  const makerSwap = maker.getByTestId("swap-panel");
  await makerSwap.getByRole("button", { name: "Scan my holdings" }).click();
  await expect(makerSwap.getByTestId("swap-give-asset").locator("option")).toHaveCount(2, {
    timeout: 120_000,
  });
  await makerSwap.getByTestId("swap-give-asset").selectOption(gold);
  await makerSwap.getByTestId("swap-give-amount").fill("3");
  await makerSwap.getByTestId("swap-want-asset").fill(silver);
  await makerSwap.getByTestId("swap-want-amount").fill("5");
  await makerSwap.getByTestId("swap-prepare").click();
  await expect(makerSwap.getByTestId("swap-board-status")).toContainText("Listed", {
    timeout: 420_000,
  });

  // --- The taker finds it on the board ---
  await taker.goto("/swaps");
  const listed = taker.getByTestId("swap-board").locator("li", { hasText: `Board Gold ${tag}` });
  await expect(listed).toBeVisible({ timeout: 30_000 });
  await expect(listed).toContainText("3");
  await expect(listed).toContainText("5");
  await listed.getByTestId("swap-take-link").click();
  await expect(taker).toHaveURL(/\/swaps\?take=[0-9a-f]{32}/);
  await expect(taker.getByTestId("swap-needs-wallet")).toContainText("take this offer");

  // A fresh load forgot the seed: the taker enters it again.
  await taker.getByRole("button", { name: "I already have one" }).click();
  await taker.getByTestId("mint-seed").fill(phrase);
  await taker.getByTestId("mint-seed-saved").check();
  const takerSwap = taker.getByTestId("swap-panel");
  await expect(takerSwap.getByTestId("swap-offer-summary")).toContainText("3", {
    timeout: 30_000,
  });
  await takerSwap.getByTestId("swap-take").click();
  await expect(takerSwap.getByTestId("swap-take-status")).toContainText("Sent to the maker", {
    timeout: 420_000,
  });

  // --- The maker's page countersigns by itself; the taker's completes ---
  await expect(takerSwap.getByTestId("swap-done")).toBeVisible({ timeout: 300_000 });
  await expect(makerSwap.getByTestId("swap-board-status")).toContainText("Swapped", {
    timeout: 120_000,
  });

  // --- Balances, from each side's own scan; the board is empty again ---
  await expect(await holding(taker, gold)).toContainText("× 3", { timeout: 120_000 });
  await expect(await holding(taker, silver)).toContainText("× 10", { timeout: 120_000 });
  await expect(await holding(maker, silver)).toContainText("× 5", { timeout: 120_000 });
  await expect(await holding(maker, gold)).toContainText("× 6", { timeout: 120_000 });
  const board = await taker.request.get("http://localhost:8080/api/v1/swaps");
  expect(((await board.json()) as { give_asset: string }[]).map((o) => o.give_asset)).not.toContain(
    gold,
  );
});
