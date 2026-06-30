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
const DEFAULT_TIMES = { 1: "17:00", 2: "17:00", 3: "17:00", 4: "17:00", 5: "17:00", 6: "10:00", 7: "09:00" };
// Mo/Di immer vorausgewählt, Mi/Do/So kein Default, Fr/Sa nur auf Biweekly-Wochen
const DEFAULT_ENABLED = { 1: true, 2: true, 3: false, 4: false, 5: null, 6: null, 7: false };
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
  // Alle Aktivitäten scrapen (nicht nur GROUP_ID 71206), Open Gym wird gefiltert
  const slots = day.locator(`li[data-group-id]`);

  const seen = new Set();
  const sessions = [];
  for (let i = 0; i < await slots.count(); i++) {
    const slot = slots.nth(i);
    const uuid  = await slot.getAttribute("data-uuid");
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    const rawTime = await slot.locator(".session-time").first().innerText().catch(() => "");
    const time    = rawTime.trim().substring(0, 5);
    const title   = await slot.locator(".session-name, [class*='session-name'], [class*='sessionName']")
                              .first().innerText().catch(() => "");
    const titleClean = title.trim();
    if (!time) continue;
    if (titleClean.toLowerCase().includes("open gym")) continue;
    sessions.push({ time, uuid, title: titleClean });
  }
  return sessions;
}

(async () => {
  const now = new Date();

  // Berlin-Datum als UTC-Mittag verankern → vermeidet alle Zeitzonen-Off-by-ones
  const berlinTodayStr = dateStr(now);
  const berlinToday = new Date(berlinTodayStr + "T12:00:00Z");
  const dow = berlinToday.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa

  // Nächsten Montag berechnen: So→+8, Mo→+7, Di→+6, …, Sa→+2
  const daysToNextMonday = dow === 0 ? 8 : (8 - dow);
  const nextMonday = new Date(berlinToday);
  nextMonday.setUTCDate(berlinToday.getUTCDate() + daysToNextMonday);

  // Zielwoche: Montag–Sonntag (deutsches Format)
  const targetDates = [];
  for (let offset = 0; offset <= 6; offset++) {
    const d  = new Date(nextMonday);
    d.setUTCDate(nextMonday.getUTCDate() + offset);
    const ds = d.toLocaleDateString("en-CA", { timeZone: "UTC" });
    const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
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

  // ISO-Woche vom Montag der Zielwoche (Sonntag gehört zur Vorwoche)
  const mondayEntry = targetDates.find(d => d.weekday === 1) ?? targetDates[1];
  const mondayDate = new Date(mondayEntry.date + "T12:00:00Z");
  const week = isoWeek(mondayDate);
  const kwNum = parseInt(week.split("-W")[1]);

  const lastDate = new Date(mondayDate);
  lastDate.setUTCDate(mondayDate.getUTCDate() + 6);
  const fmtShort = d => d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });

  // Bestehenden locked-Status beibehalten, wenn selbe Woche
  let locked = false;
  try {
    const existingRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `Bearer ${GIST_TOKEN}` },
    });
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      const existingRaw = existingData.files?.["schedule.json"]?.content ?? "{}";
      const existing = JSON.parse(existingRaw);
      if (existing.week === week) locked = existing.locked ?? false;
    }
  } catch { /* ignorieren */ }

  const content = JSON.stringify({ week, locked, days }, null, 2);

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
      return `${label} - ${d.selectedTime.replace(":", ".")} Uhr`;
    });

  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Kurse KW ${kwNum} / ${fmtShort(mondayDate)} - ${fmtShort(lastDate)} 🏋️`,
      message: lines.length > 0
        ? `📅 Default naechste Woche:\n${lines.join("\n")}`
        : "Keine Kurse naechste Woche.",
      actions: [{ action: "view", label: "Verwalten", url: "https://christiankohl.github.io/eversports/" }],
    }),
  });
  console.log("Notification gesendet.");
})();
