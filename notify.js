// Läuft jeden Sonntag ~10:00 Berlin via GitHub Actions.
// Scrapt CrossFit-Sessions für die übernächste Woche (today+7 … today+13),
// schreibt sie in den Gist und schickt eine ntfy-Benachrichtigung.

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const GIST_ID    = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const STUDIO_URL = "https://www.eversports.de/st/crossfit-kur-pals";
const GROUP_ID   = "71206";
const BIWEEKLY_START  = new Date("2026-03-09T00:00:00Z");
const CROSSFIT_DAYS   = new Set([1, 2, 5, 6]); // Mo Di Fr Sa
const DEFAULT_TIMES   = { 1: "17:00", 2: "17:00", 5: "17:00", 6: "10:00" };
const DAY_NAMES_LONG  = ["", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

function berlinDate(d) {
  return new Date(d.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
}
function dateStr(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}
function isoWeekday(d) {
  const day = berlinDate(d).getDay();
  return day === 0 ? 7 : day;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(d.getDate() + n);
  return r;
}
function isBiweeklyActive(ds) {
  const ms = new Date(ds + "T00:00:00Z").getTime();
  const diffDays = Math.round((ms - BIWEEKLY_START.getTime()) / 86_400_000);
  return Math.floor(diffDays / 7) % 2 === 0;
}
function bookingDateFor(courseDate) {
  const d = new Date(courseDate + "T12:00:00Z");
  d.setDate(d.getDate() - 5);
  return d.toLocaleDateString("en-CA", { timeZone: "UTC" });
}
function isoWeek(d) {
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const start = new Date(jan4);
  start.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const w = Math.floor((d - start) / (7 * 86400000)) + 1;
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

async function scrapeSessions(page, targetDate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await page.locator(`h3[data-day="${targetDate}"]`).count() > 0) break;
    await page.getByTestId("show-next-week-action").click();
    await page.waitForTimeout(1500);
  }
  if (await page.locator(`h3[data-day="${targetDate}"]`).count() === 0) {
    console.log(`${targetDate} nicht im Kalender sichtbar.`);
    return [];
  }
  const day   = page.locator(`.calendar__day:has(h3[data-day="${targetDate}"])`);
  const slots = day.locator(`li[data-group-id="${GROUP_ID}"]`);
  const sessions = [];
  for (let i = 0; i < await slots.count(); i++) {
    const slot = slots.nth(i);
    const rawTime = await slot.locator(".session-time").first().innerText().catch(() => "");
    const uuid    = await slot.getAttribute("data-uuid");
    const time    = rawTime.trim().substring(0, 5);
    if (uuid && time) sessions.push({ time, uuid });
  }
  return sessions;
}

(async () => {
  const now = new Date();

  // Ziel-Kursdaten: today+7 … today+13 (nächste Woche ab Sonntag)
  const targetDates = [];
  for (let offset = 7; offset <= 13; offset++) {
    const d  = addDays(now, offset);
    const ds = dateStr(d);
    const wd = isoWeekday(d);
    if (!CROSSFIT_DAYS.has(wd)) continue;
    if ((wd === 5 || wd === 6) && !isBiweeklyActive(ds)) continue;
    targetDates.push({ date: ds, weekday: wd, dayName: DAY_NAMES_LONG[wd] });
  }

  if (targetDates.length === 0) {
    console.log("Keine Kurse nächste Woche (2-Wochen-Rhythmus).");
    process.exit(0);
  }
  console.log("Scrape für:", targetDates.map(d => d.date));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: "auth.json", locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  await page.goto(STUDIO_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".calendar__day", { timeout: 30000 });
  try {
    await page.locator("[role=dialog] button").first().waitFor({ timeout: 3000 });
    await page.locator("[role=dialog] button").first().click();
    await page.waitForTimeout(500);
  } catch {}

  const days = [];
  for (const { date, weekday, dayName } of targetDates) {
    const sessions = await scrapeSessions(page, date);
    const defaultTime = DEFAULT_TIMES[weekday];
    const defaultSession = sessions.find(s => s.time === defaultTime) ?? sessions[0] ?? null;
    days.push({
      date,
      dayName,
      bookingDate: bookingDateFor(date),
      sessions,
      selectedTime: defaultSession?.time ?? null,
      selectedUuid: defaultSession?.uuid ?? null,
      enabled: sessions.length > 0,
    });
    console.log(`${date} (${dayName}): ${sessions.map(s => s.time).join(", ") || "keine Sessions"}`);
  }
  await browser.close();

  const week = isoWeek(new Date(targetDates[0].date + "T12:00:00Z"));
  const content = JSON.stringify({ week, locked: false, days }, null, 2);

  const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files: { "schedule.json": { content } } }),
  });
  if (!gistRes.ok) throw new Error(`Gist-Update fehlgeschlagen: ${gistRes.status}`);
  console.log("Gist aktualisiert.");

  const lines = days.map(d => {
    const dt = new Date(d.date + "T12:00:00Z");
    const label = dt.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
    return `${d.enabled ? "✓" : "–"} ${label}  ${d.selectedTime ?? "kein Slot"}`;
  });
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: `Kurse Woche ${week}`,
      Actions: `view, Verwalten, https://christiankohl.github.io/eversports/`,
    },
    body: `Buchbar naechste Woche:\n${lines.join("\n")}`,
  });
  console.log("Notification gesendet.");
})();
