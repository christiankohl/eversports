import { chromium } from "playwright";

const STUDIO_URL = "https://www.eversports.de/st/crossfit-kur-pals";
const GROUP_ID = "71206";
// Referenz-Montag für den 2-Wochen-Rhythmus
const BIWEEKLY_START = new Date("2026-03-09T00:00:00Z");

// Buchung erfolgt 5 Tage vor dem Kursdatum.
// Key = ISO-Wochentag HEUTE in Berlin (1=Mo...7=So)
// Wed(3) → bucht Mo-Kurs @ 17:00
// Thu(4) → bucht Di-Kurs @ 17:00
// Sun(7) → bucht Fr-Kurs @ 17:00 (2-Wochen-Rhythmus)
// Mon(1) → bucht Sa-Kurs @ 10:00 (2-Wochen-Rhythmus)
const SCHEDULE = {
  3: { releaseTime: "17:00", biweekly: false },
  4: { releaseTime: "17:00", biweekly: false },
  7: { releaseTime: "17:00", biweekly: true  },
  1: { releaseTime: "10:00", biweekly: true  },
};

function getBerlinWeekday() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  return d.getDay() === 0 ? 7 : d.getDay(); // ISO: 1=Mo...7=So
}

function getTargetDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }); // YYYY-MM-DD
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
  const weekday = getBerlinWeekday();
  const schedule = SCHEDULE[weekday];

  if (!schedule) {
    console.log(`Kein Buchungstag (ISO-Wochentag ${weekday}). Beende.`);
    process.exit(0);
  }

  const targetDate = getTargetDateStr();

  if (schedule.biweekly && !isBiweeklyActive(targetDate)) {
    console.log(`2-Wochen-Rhythmus: inaktiv für Zieldatum ${targetDate}. Beende.`);
    process.exit(0);
  }

  console.log(`Buchungstag! Ziel: ${targetDate} @ ${schedule.releaseTime} Berlin`);

  await waitForRelease(schedule.releaseTime);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: "auth.json" });
  const page = await context.newPage();

  await page.goto(STUDIO_URL);
  await page.waitForSelector(".calendar__day");

  if (await page.locator(`h3[data-day="${targetDate}"]`).count() === 0) {
    console.log("Zieldatum nicht sichtbar → nächste Woche");
    await page.getByTestId("show-next-week-action").click();
    await page.waitForTimeout(1500);
  }

  const day = page.locator(`.calendar__day:has(h3[data-day="${targetDate}"])`);
  const slot = day.locator(`li[data-group-id="${GROUP_ID}"]`, {
    has: page.locator(`.session-time:has-text("${schedule.releaseTime}")`),
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

  console.log("Slot gefunden → buchen");
  await slot.click();
  await page.getByRole("button", { name: /buchen/i }).click();

  console.log("Buchung ausgelöst ✅");
  await page.waitForTimeout(3000);
  await browser.close();
})();
