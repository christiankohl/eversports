import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const STUDIO_URL = "https://www.eversports.de/st/crossfit-kur-pals";
const GROUP_ID = "71206";
const BIWEEKLY_START = new Date("2026-03-09T00:00:00Z");

// Buchung 5 Tage vor dem Kurs. Key = ISO-Wochentag HEUTE in Berlin.
const SCHEDULE = {
  3: { releaseTime: "17:00", biweekly: false }, // Mi → bucht Mo
  4: { releaseTime: "17:00", biweekly: false }, // Do → bucht Di
  7: { releaseTime: "17:00", biweekly: true  }, // So → bucht Fr
  1: { releaseTime: "10:00", biweekly: true  }, // Mo → bucht Sa
};

function getBerlinWeekday() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  return d.getDay() === 0 ? 7 : d.getDay();
}

function getTargetDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

function isBiweeklyActive(targetDateStr) {
  const targetMs = new Date(targetDateStr + "T00:00:00Z").getTime();
  const diffDays = Math.round((targetMs - BIWEEKLY_START.getTime()) / 86_400_000);
  return Math.floor(diffDays / 7) % 2 === 0;
}

async function waitForRelease(releaseTime) {
  const [rHour, rMin] = releaseTime.split(":").map(Number);
  while (true) {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const h = now.getHours(), m = now.getMinutes();
    if (h > rHour || (h === rHour && m >= rMin)) break;
    const waitMs = ((rHour * 60 + rMin) - (h * 60 + m)) * 60_000 - now.getSeconds() * 1000;
    console.log(`Warte auf ${releaseTime} Berlin (noch ~${Math.ceil(waitMs / 60_000)} min)`);
    await new Promise(r => setTimeout(r, Math.min(waitMs, 30_000)));
  }
  console.log(`Release-Zeit ${releaseTime} (Berlin) erreicht.`);
}

(async () => {
  // Test-Override: TARGET_DATE=2026-06-30 RELEASE_TIME=17:00 node book.js
  const forceDate = process.env.TARGET_DATE;
  const forceTime = process.env.RELEASE_TIME;

  let targetDate, releaseTime;

  if (forceDate && forceTime) {
    targetDate = forceDate;
    releaseTime = forceTime;
    console.log(`[TEST] Manueller Override: ${targetDate} @ ${releaseTime}`);
  } else {
    const weekday = getBerlinWeekday();
    const schedule = SCHEDULE[weekday];

    if (!schedule) {
      console.log(`Kein Buchungstag (ISO-Wochentag ${weekday}). Beende.`);
      process.exit(0);
    }

    targetDate = getTargetDateStr();

    if (schedule.biweekly && !isBiweeklyActive(targetDate)) {
      console.log(`2-Wochen-Rhythmus: inaktiv für Zieldatum ${targetDate}. Beende.`);
      process.exit(0);
    }

    releaseTime = schedule.releaseTime;
    console.log(`Buchungstag! Ziel: ${targetDate} @ ${releaseTime} Berlin`);
    await waitForRelease(releaseTime);
  }

  const isTest = !!process.env.TARGET_DATE;
  const browser = await chromium.launch({ headless: !isTest, channel: isTest ? "chrome" : undefined });
  const context = await browser.newContext({ storageState: "auth.json" });
  const page = await context.newPage();

  await page.goto(STUDIO_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".calendar__day", { timeout: 30000 });

  // Cookie-Dialog wegklicken
  try {
    const cookieBtn = page.locator("[role=dialog] button").first();
    await cookieBtn.waitFor({ timeout: 3000 });
    await cookieBtn.click();
    await page.waitForTimeout(500);
  } catch { /* kein Dialog */ }

  if (await page.locator(`h3[data-day="${targetDate}"]`).count() === 0) {
    console.log("Zieldatum nicht sichtbar → nächste Woche");
    await page.getByTestId("show-next-week-action").click();
    await page.waitForTimeout(1500);
  }

  const day = page.locator(`.calendar__day:has(h3[data-day="${targetDate}"])`);
  const slot = day.locator(`li[data-group-id="${GROUP_ID}"]`, {
    has: page.locator(`.session-time:has-text("${releaseTime}")`),
  });

  let found = false;
  for (let i = 0; i < 10; i++) {
    if (await slot.count() > 0) { found = true; break; }
    console.log(`Slot noch nicht sichtbar, Versuch ${i + 1}/10…`);
    await page.waitForTimeout(500);
  }

  if (!found) {
    console.log("Slot nicht gefunden. Beende.");
    await browser.close();
    process.exit(1);
  }

  if (await slot.locator("text=ausgebucht").count() > 0) {
    console.log("Slot ist ausgebucht.");
    await browser.close();
    process.exit(0);
  }

  // Slot → Activity-Seite
  console.log("Slot gefunden → öffnen");
  await slot.first().scrollIntoViewIfNeeded();
  const box = await slot.first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForURL(/\/activity\//, { timeout: 10000 });

  // Activity-Seite → Phoenix Checkout
  const bookLink = page.getByRole("link", { name: /jetzt buchen/i });
  await bookLink.waitFor({ timeout: 10000 });
  await bookLink.click();
  await page.waitForURL(/\/phoenix\//, { timeout: 10000 });

  // Produkt auswählen (erste Karte) und buchen
  const productCard = page.locator("button")
    .filter({ hasNot: page.locator("text=Stornierungsbedingungen") })
    .filter({ hasNot: page.locator("text=Jetzt buchen") })
    .first();
  if (await productCard.count() > 0) {
    await productCard.click();
    await page.waitForTimeout(1000);
  }

  const checkoutButton = page.getByRole("button", { name: /jetzt buchen/i });
  await checkoutButton.waitFor({ timeout: 5000 });
  await checkoutButton.click();

  await page.waitForURL(/\/confirmation/, { timeout: 10000 });
  console.log("Buchung bestätigt ✅", page.url());

  await browser.close();
})();
