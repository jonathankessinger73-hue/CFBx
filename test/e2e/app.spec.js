import { test, expect } from "@playwright/test";
import fs from "node:fs";

const fakeSupabase = fs.readFileSync(new URL("./fake-supabase.js", import.meta.url), "utf8");

test("the real Supabase bundle loads and boots the app", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/");
  await expect(page.locator("a.card")).toHaveCount(138);
  expect(await page.evaluate(() => typeof window.supabase?.createClient)).toBe("function");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("with fake auth", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/vendor/supabase.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: fakeSupabase })
    );
    page.on("pageerror", (err) => {
      throw err;
    });
  });

  test("signed-out visitors can browse the market and team pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Market — Week 3" })).toBeVisible();
    await expect(page.locator("a.card")).toHaveCount(138);
    await expect(page.locator("#tape .tape-item").first()).toBeVisible();

    await page.getByLabel("Search programs").fill("bulldogs");
    await expect(page.locator("a.card")).toHaveCount(4); // UGA, MSST, FRES, LT
    await page.getByLabel("Search programs").fill("");
    await page.getByLabel("Conference").selectOption("SEC");
    await expect(page.locator("a.card")).toHaveCount(16);

    await page.locator('a.card[href="#/team/UGA"]').click();
    await expect(page.getByRole("heading", { name: "Georgia" })).toBeVisible();
    await expect(page.locator(".log-item").first()).toContainText("Week 3");
    const upNext = page.locator(".upcoming-item");
    await expect(upNext.first()).toContainText("Oklahoma");
    await expect(upNext.first()).toContainText("favored by 14.0");
    await expect(upNext.first()).toContainText("REAL LINE");
    await expect(upNext.nth(1)).toContainText("PROJECTED");
    await expect(page.getByText("Sign in to trade.")).toBeVisible();

    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.getByText("Sign in to see your portfolio")).toBeVisible();
  });

  test("sign in, buy, see the position, sell", async ({ page }) => {
    await page.goto("/#/signin");
    await page.getByLabel("Email").fill("fan@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.locator("#hdr-cash")).toHaveText("$10,000.00");

    await page.goto("/#/team/UGA");
    const priceText = await page.locator(".detail-price .px").innerText();
    const price = Number(priceText.replace("$", ""));
    await page.getByLabel("Shares").fill("3");
    await page.getByRole("button", { name: "Buy" }).click();
    await expect(page.locator("#toast")).toContainText(`Bought 3 UGA @ $${price.toFixed(2)}`);
    const cashAfter = 10000 - Math.round(price * 3 * 100) / 100;
    await expect(page.locator("#hdr-cash")).toHaveText(
      "$" + cashAfter.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
    await expect(page.getByText(/^3 shares @ avg/)).toBeVisible();

    // Can't buy more than cash allows; can't sell more than held.
    await page.getByLabel("Shares").fill("100000");
    await expect(page.getByRole("button", { name: "Buy" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sell" })).toBeDisabled();

    await page.getByRole("link", { name: "Back to market" }).click();
    await expect(page.locator('a.card[href="#/team/UGA"] .held-badge')).toHaveText("3 sh");

    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.locator("table.holdings tbody tr")).toHaveCount(1);
    await expect(page.locator("table.holdings")).toContainText("Georgia");
    await expect(page.locator(".log-list .log-item").first()).toContainText(`Bought 3 UGA @ $${price.toFixed(2)}`);

    await page.goto("/#/team/UGA");
    await page.getByLabel("Shares").fill("3");
    await page.getByRole("button", { name: "Sell" }).click();
    await expect(page.locator("#toast")).toContainText("Sold 3 UGA");
    await expect(page.locator("#hdr-cash")).toHaveText("$10,000.00");
    await expect(page.getByText("No position yet.")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
  });

  test("fits a phone-width screen without horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/", "/#/team/OSU", "/#/portfolio"]) {
      await page.goto(path);
      await page.waitForSelector("main :is(.grid, .detail-head, .section-head)");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
