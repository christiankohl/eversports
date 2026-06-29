// Läuft jeden Sonntag ~10:00 Berlin via GitHub Actions.
// Scrapt CrossFit-Sessions Mo–Sa für die kommende Woche (today+7…today+13),
// schreibt sie in den Gist und schickt eine ntfy-Benachrichtigung.

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const GIST_ID    = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const STUDIO_URL = "https://www.eversports.de/st/crossfit-kur-pals";
const GROUP_ID   = "71206";
const BIWEEKLY_START = new Date("2026-03-09T00:00:00Z");

// Standardzeiten für Default-Vorauswahl pro Wochentag
const DEFAULT_TIMES = { 1: "17:00", 2: "17:00", 3: "17:00", 4: "17:00", 5: "17:00", 6: "10:00" };
// Default aktiviert: Mo/Di immer, Mi/Do default aus, Fr/Sa nur bei Biweekly
const DEFAULT_ENABLED = { 1: true, 2: true, 3: false, 4: false, 5: null, 6: null };
const DAY_NAMES_LONG = ["", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

function berlinDate(d) { return new Date(d.toLocaleString("en-US", { timeZone: "Europe/Berlin" })); }
function dateStr(d)    { return d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }); }
function isoWeekday(d) { const day = berlinDate(d).getDay(); return day === 0 ? 7 : day; }
function addDays(d, n) { const r = new Date(d); r.setDate(d.getDate() + n); return r; }

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
  // .first() verhindert doppeltes Matching wenn der Kalender die Spalte mehrfach rendert
  const day   = page.locator(`.calendar__day:has(h3[data-day="${targetDate}"])`).first();
  const slots = day.locator(`li[data-group-id="${GROUP_ID}"]`);

  const seen = new Set();
  const sessions = [];
  for (let i = 0; i < await slots.count(); i++) {
    const slot = slots.nth(i);
    const uuid    = await slot.getAttribute("data-uuid");
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    const rawTime = await slot.locator(".session-time").first().innerText().catch(() => "");
    const time    = rawTime.trim().substring(0, 5);
    const title   = await slot.locator(".session-name, [class*='session-name'], [class*='sessionName']")
                              .first().innerText().catch(() => "");
    if (time) sessions.push({ time, uuid, title: title.trim() });
  }
  return sessions;
}

(async () => {
  const now = new Date();

  // Alle Wochentage Mo–Sa der kommenden Woche (today+7…today+13 ab Sonntag)
  const targetDates = [];
  for (let offset = 7; offset <= 13; offset++) {
    const d  = addDays(now, offset);
    const ds = dateStr(d);
    const wd = isoWeekday(d);
    if (wd === 7) continue; // Sonntag überspringen
    targetDates.push({ date: ds, weekday: wd, dayName: DAY_NAMES_LONG[wd] });
  }

  console.log("Scrape für:", targetDates.map(d => d.date));

  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ storageState: "auth.json", locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page    = await context.newPage();
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
    const defTime  = DEFAULT_TIMES[weekday];
    const defSess  = sessions.find(s => s.time === defTime) ?? sessions[0] ?? null;
    let defEnabled = DEFAULT_ENABLED[weekday];
    if (defEnabled === null) defEnabled = isBiweeklyActive(date);

    days.push({
      date,
      dayName,
      bookingDate: bookingDateFor(date),
      sessions,
      selectedTime: defSess?.time ?? null,
      selectedUuid: defSess?.uuid ?? null,
      enabled: sessions.length > 0 && defEnabled,
    });
    const tag = defEnabled ? "✓" : "–";
    console.log(`${tag} ${date} (${dayName}): ${sessions.map(s => s.time).join(", ") || "keine Sessions"}`);
  }
  await browser.close();

  const enabledDays = days.filter(d => d.sessions.length > 0);
  if (enabledDays.length === 0) {
    console.log("Keine Sessions gefunden.");
    process.exit(0);
  }

  const week    = isoWeek(new Date(targetDates[0].date + "T12:00:00Z"));
  const content = JSON.stringify({ week, locked: false, days }, null, 2);

  const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files: { "schedule.json": { content } } }),
  });
  if (!gistRes.ok) throw new Error(`Gist-Update fehlgeschlagen: ${gistRes.status}`);
  console.log("Gist aktualisiert.");

  const lines = days
    .filter(d => d.enabled && d.selectedTime)
    .map(d => {
      const dt = new Date(d.date + "T12:00:00Z");
      const label = dt.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
      return `${label}  ${d.selectedTime}`;
    });

  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: `Kurse Woche ${week}`,
      Actions: `view, Verwalten, https://christiankohl.github.io/eversports/`,
    },
    body: lines.length > 0
      ? `Buchbar naechste Woche:\n${lines.join("\n")}`
      : "Keine Kurse naechste Woche.",
  });
  console.log("Notification gesendet.");
})();
