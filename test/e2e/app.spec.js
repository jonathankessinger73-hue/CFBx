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

    // Market cards show the overall and ATS record.
    await expect(page.locator('a.card[href="#/team/UGA"] .rec')).toHaveText("2-0 · ATS 2-0");
    await page.locator('a.card[href="#/team/UGA"]').click();
    await expect(page.getByRole("heading", { name: "Georgia" })).toBeVisible();
    // Team page: overall, conference (labelled with its name) and ATS.
    await expect(page.locator(".rec-chip")).toHaveText([/overall\s*2-0/, /SEC\s*1-0/, /vs spread\s*2-0/]);
    await expect(page.locator(".log-item").first()).toContainText("Week 3");
    const upNext = page.locator(".upcoming-item");
    await expect(upNext.first()).toContainText("Oklahoma");
    await expect(upNext.first()).toContainText("favored by 14.0");
    await expect(upNext.first()).toContainText("REAL LINE");
    await expect(upNext.nth(1)).toContainText("PROJECTED");
    await expect(page.getByText("Sign in to trade.")).toBeVisible();

    // Price chart: week labels, opening + latest price labelled, per-week tooltip.
    const chart = page.locator(".chart-box svg");
    await expect(chart.locator("text.axis-label", { hasText: "Open" })).toBeVisible();
    await expect(chart.locator("text.axis-label", { hasText: "W3" })).toBeVisible();
    const current = (await page.locator(".detail-price .px").innerText()).trim();
    await expect(chart.locator("text.chart-value").last()).toHaveText(current);
    // UGA has a news move after its last game (e2e data), so the chart ends
    // on a "Now" point after week 3.
    const hits = chart.locator(".chart-hit");
    const tip = page.locator(".chart-tip");
    await hits.last().hover();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Now");
    await expect(tip).toContainText(current);
    await hits.nth((await hits.count()) - 2).hover();
    await expect(tip).toContainText("Week 3");
    await expect(tip).toContainText("vs Arkansas");
    // The game log lists each week's resulting price too, matching the chart.
    const week3 = (await page.locator(".log-item").first().locator(".log-price").innerText()).replace("\u2192", "").trim();
    await expect(tip).toContainText(week3);
    await hits.first().focus();
    await expect(tip).toContainText("Opening price");

    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.getByText("Sign in to see your portfolio")).toBeVisible();
  });

  test("team logos show where known; a logo that can't load falls back to the helmet", async ({ page }) => {
    await page.goto("/");
    const uga = page.locator('a.card[href="#/team/UGA"]');
    await expect(uga.locator("img.team-logo")).toHaveJSProperty("complete", true);
    expect(await uga.locator("img.team-logo").evaluate((img) => img.naturalWidth > 0)).toBe(true);
    const ala = page.locator('a.card[href="#/team/ALA"]');
    await expect(ala.locator("img.team-logo")).toHaveCount(0);
    await expect(ala.locator(".team-mark-fallback svg")).toBeVisible();
    await expect(page.locator('a.card[href="#/team/OSU"] svg').first()).toBeVisible();

    await page.goto("/#/team/UGA");
    await expect(page.locator(".detail-head img.team-logo")).toBeVisible();
    // Price moves between games show under "market news".
    await expect(page.getByRole("heading", { name: "market news" })).toBeVisible();
    await expect(page.getByText("Up 3 spots to No. 2 in the AP poll")).toBeVisible();
  });

  test("options: buy a call from the team page, see it in the portfolio; paused during a live game", async ({ page }) => {
    await page.goto("/#/signin");
    await page.getByLabel("Email").fill("options@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.locator("#hdr-cash")).toHaveText("$10,000.00");

    await page.goto("/#/team/UGA");
    const panel = page.locator(".options-panel");
    await expect(panel).toContainText("Football price now");
    await expect(panel.locator(".opt-row")).toHaveCount(5);
    await expect(panel.locator(".opt-row.selected")).toHaveCount(1); // nearest strike preselected
    // Each strike shows its prices on Buy / Sell buttons; tapping one picks that option.
    await expect(panel.locator(".opt-row").first().locator(".opt-px-buy")).toHaveText(/^Buy \$\d+\.\d\d$/);
    await panel.locator(".opt-row").first().locator(".opt-px-buy").click();
    await expect(panel.locator(".opt-row").first()).toHaveClass(/selected/);
    await expect(page.locator(".opt-contract")).toContainText("UGA");
    await panel.getByRole("button", { name: "Puts" }).click();
    await expect(panel.getByRole("button", { name: "Puts" })).toHaveClass(/active/);
    await panel.getByRole("button", { name: "Calls" }).click();
    await panel.getByRole("button", { name: "Season" }).click();
    await expect(panel).toContainText("settles after the national title game");

    await panel.getByLabel("Options").fill("4");
    await expect(page.locator("#opt-summary")).toContainText("Buy 4");
    await expect(page.locator("#opt-summary")).toContainText("breaks even above");
    await expect(panel.getByRole("button", { name: /^Buy 4 @ \$\d+\.\d\d$/ })).toBeVisible();
    await panel.getByRole("button", { name: /^Buy 4 @/ }).click();
    // Strikes can be fractional (e.g. $56.50) depending on the seed prices.
    await expect(page.locator("#toast")).toContainText(/Bought 4 UGA \$\d+(\.\d+)? calls @/);
    await expect(panel.locator(".opt-row.selected td").last()).toHaveText("4");

    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.getByRole("heading", { name: "options", exact: true })).toBeVisible();
    await expect(page.locator("table.holdings").last()).toContainText("UGA");
    await expect(page.getByRole("heading", { name: "options activity" })).toBeVisible();
    await expect(page.getByText(/Bought 4 UGA \$\d+(\.\d+)? call @/)).toBeVisible();

    // TEX is mid-game in the e2e data: its options are paused.
    await page.goto("/#/team/TEX");
    await expect(page.locator(".opt-paused")).toContainText("paused while");
    await expect(page.locator("#opt-buy")).toHaveCount(0);
  });

  test("a team playing right now shows LIVE with the score", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('a.card[href="#/team/TEX"] .live-tag')).toHaveText("LIVE");
    await expect(page.locator('a.card[href="#/team/UGA"] .live-tag')).toHaveCount(0);
    await page.goto("/#/team/TEX");
    await expect(page.locator(".live-line")).toContainText("Q3 7:32 · TENN 10, TEX 21");
  });

  test("privacy and terms pages are linked from every page", async ({ page }) => {
    await page.goto("/");
    await page.locator("footer").getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
    await page.locator("footer").getByRole("link", { name: "Terms" }).click();
    await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
  });

  test("sign-in: Google button, and a code from the email when the link isn't handy", async ({ page }) => {
    await page.goto("/#/signin");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    expect(await page.evaluate(() => window.__oauthProvider)).toBe("google");

    await page.getByLabel("Email").fill("fan+code@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByRole("heading", { name: "check your email" })).toBeVisible();
    await expect(page.locator(".auth-panel")).toContainText("noreply@mail.example.test");
    await expect(page.getByText("Don't see it?")).toBeVisible();
    await expect(page.getByRole("button", { name: /Resend in \d+s/ })).toBeDisabled();

    await page.getByLabel("Sign-in code").fill("000000");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#code-msg")).toContainText("didn't work");

    await page.getByLabel("Sign-in code").fill("123 456");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#hdr-cash")).toHaveText("$10,000.00");
    await expect(page).not.toHaveURL(/signin/);
  });

  test("sign in, buy, see the position, sell", async ({ page }) => {
    await page.goto("/#/signin");
    await page.getByLabel("Email").fill("fan@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.locator("#hdr-cash")).toHaveText("$10,000.00");

    await page.goto("/#/team/UGA");
    const money = (text) => Number(text.replace(/[$,]/g, ""));
    const price = money(await page.locator(".detail-price .px").innerText());
    await page.getByLabel("Shares").fill("3");
    // The live quote: 3 shares cost a little more than 3 x price (the order
    // nudges the price up as it fills, plus the spread).
    const cost = async () => money(await page.locator("#trade-cost").innerText());
    await expect.poll(cost).toBeGreaterThan(price * 3);
    const total = await cost();
    expect(total).toBeLessThan(price * 3 * 1.01);
    await page.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(page.locator("#toast")).toContainText("Bought 3 UGA @ $");
    await expect(page.locator("#hdr-cash")).toHaveText(
      "$" + (10000 - total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
    await expect(page.getByText(/^3 shares @ avg/)).toBeVisible();
    // Your position (total return) and your history for this team.
    const position = page.locator(".position-box");
    await expect(position).toContainText("total return");
    await expect(position).toContainText(/-\$\d+\.\d\d/); // just bought: down by the spread
    await expect(position.locator(".summary-card").nth(1)).toContainText("3 shares @");
    await expect(position.locator(".summary-card")).toHaveCount(2); // no options held: no options box
    await expect(page.getByRole("heading", { name: "your history" })).toBeVisible();
    await expect(page.getByText(/Bought 3 shares @ \$/)).toBeVisible();
    // Buying moved the price up.
    await expect.poll(async () => money(await page.locator(".detail-price .px").innerText())).toBeGreaterThan(price);

    // Can't buy more than cash allows; can't sell more than held.
    await page.getByLabel("Shares").fill("100000");
    await expect(page.getByRole("button", { name: "Buy", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sell", exact: true })).toBeDisabled();

    await page.getByRole("link", { name: "Back to market" }).click();
    await expect(page.locator('a.card[href="#/team/UGA"] .held-badge')).toHaveText("3 sh");

    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.locator("table.holdings tbody tr")).toHaveCount(1);
    await expect(page.locator("table.holdings")).toContainText("Georgia");
    await expect(page.locator(".log-list .log-item").first()).toContainText("Bought 3 UGA @ $");
    // Team logos (UGA has one in the e2e data) next to the holding and the trade.
    await expect(page.locator("table.holdings tbody tr img.team-logo")).toBeVisible();
    await expect(page.locator(".log-list .log-item").first().locator("img.team-logo")).toBeVisible();
    // Returns panel: one period at a time, switched with its buttons.
    const returns = page.locator(".returns-panel");
    await expect(returns.getByRole("button", { name: "1W" })).toHaveClass(/active/);
    await expect(returns.locator(".returns-note")).toContainText("Past week: since you joined on");
    await returns.getByRole("button", { name: "All-time" }).click();
    await expect(returns.getByRole("button", { name: "All-time" })).toHaveClass(/active/);
    await expect(returns.locator(".returns-note")).toContainText("Since you joined on");
    await expect(returns.locator(".returns-note")).toContainText("$10,000.00 →");
    await expect(returns.locator(".returns-val .ch").first()).toHaveText(/^[+-]\$\d/);

    await page.goto("/#/team/UGA");
    await page.getByLabel("Shares").fill("3");
    await page.getByRole("button", { name: "Sell", exact: true }).click();
    await expect(page.locator("#toast")).toContainText("Sold 3 UGA");
    // Selling straight back costs only the 0.5% spread.
    await expect
      .poll(async () => money(await page.locator("#hdr-cash").innerText()))
      .toBeGreaterThan(10000 - price * 3 * 0.01);
    expect(money(await page.locator("#hdr-cash").innerText())).toBeLessThan(10000);
    await expect(page.getByText("No position yet.")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
  });

  test("leaderboard: opt in with a display name, see your rank, names are unique", async ({ page, browser }) => {
    await page.goto("/#/leaderboard");
    await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
    await expect(page.getByText("and pick a display name to join the leaderboard")).toBeVisible();

    const signIn = async (p, email) => {
      await p.goto("/#/signin");
      await p.getByLabel("Email").fill(email);
      await p.getByRole("button", { name: "Email me a link" }).click();
      await expect(p.locator("#hdr-cash")).toBeVisible();
    };
    await signIn(page, "first@example.com");

    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.getByText("You're not on the leaderboard.")).toBeVisible();
    await page.getByRole("link", { name: "Pick a display name" }).click();

    await page.getByLabel("Display name").fill("x!");
    await page.getByRole("button", { name: "Join leaderboard" }).click();
    await expect(page.locator("#name-msg")).toContainText("Use 3\u201324 letters");

    await page.getByLabel("Display name").fill("Buckeye Bull");
    await page.getByRole("button", { name: "Join leaderboard" }).click();
    await expect(page.locator("#toast")).toContainText("You're on the leaderboard as Buckeye Bull");
    await expect(page.locator(".summary-card").first()).toContainText("#1");
    const myRow = page.locator("tr.me-row");
    await expect(myRow).toContainText("Buckeye Bull");
    await expect(myRow).toContainText("you");

    // A second player can't take the same name, in any case.
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await other.route("**/vendor/supabase.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: fakeSupabase })
    );
    await signIn(other, "second@example.com");
    await other.goto("/#/leaderboard");
    await other.getByLabel("Display name").fill("buckeye bull");
    await other.getByRole("button", { name: "Join leaderboard" }).click();
    await expect(other.locator("#name-msg")).toHaveText("That name is taken. Try another.");
    await other.getByLabel("Display name").fill("Second Fiddle");
    await other.getByRole("button", { name: "Join leaderboard" }).click();
    // Both still at $10,000 (no price has moved since signup): tied for #1.
    await expect(other.locator(".summary-card").first()).toContainText("#1 of 2");
    await expect(other.locator("table.holdings tbody tr")).toHaveCount(2);
    await expect(other.locator("table.holdings tbody .medal-1")).toHaveCount(2);
    await ctx.close();

    // Renaming keeps your place.
    await page.reload();
    await page.getByRole("button", { name: "Change name" }).click();
    await page.getByLabel("Display name").fill("Buckeye Bear");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("tr.me-row")).toContainText("Buckeye Bear");
    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.getByText("Playing as")).toContainText("Buckeye Bear");
  });

  test("fits a phone-width screen without horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/", "/#/team/OSU", "/#/portfolio", "/#/leaderboard"]) {
      await page.goto(path);
      await page.waitForSelector("main :is(.grid, .detail-head, .section-head)");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
