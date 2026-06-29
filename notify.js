// Läuft jeden Sonntag ~10:00 Berlin via GitHub Actions
// Berechnet die Kurse der Woche, schreibt sie in den Gist, schickt ntfy-Benachrichtigung

const GIST_ID    = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const BIWEEKLY_START = new Date("2026-03-09T00:00:00Z");

// Default-Zeiten pro Wochentag des KURSES (ISO 1=Mo…7=So)
const DEFAULT_TIMES = { 1: "17:00", 2: "17:00", 5: "17:00", 6: "10:00" };
const BIWEEKLY_DAYS = new Set([5, 6]);

function dateStr(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

function isBiweeklyActive(dateStr) {
  const ms = new Date(dateStr + "T00:00:00Z").getTime();
  const diffDays = Math.round((ms - BIWEEKLY_START.getTime()) / 86_400_000);
  return Math.floor(diffDays / 7) % 2 === 0;
}

function isoWeekday(d) {
  const day = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Berlin" })).getDay();
  return day === 0 ? 7 : day;
}

function weekLabel(d) {
  // ISO-Wochennummer
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const start = new Date(jan4);
  start.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const week = Math.floor((d - start) / (7 * 86400000)) + 1;
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dayName(isoDay) {
  return ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][isoDay];
}

function buildCourses() {
  const now = new Date();
  const courses = [];

  // Von Sonntag aus: die 4 Buchungstage der Woche sind So, Mo, Mi, Do
  // Jeder bucht 5 Tage voraus → Kursdaten: Fr, Sa, Mo+7, Di+7
  const bookingOffsets = [0, 1, 3, 4]; // Tage ab heute (Sonntag)

  for (const offset of bookingOffsets) {
    const bookDay = new Date(now);
    bookDay.setDate(now.getDate() + offset);

    const courseDay = new Date(bookDay);
    courseDay.setDate(bookDay.getDate() + 5);

    const courseDateStr = dateStr(courseDay);
    const courseWeekday = isoWeekday(courseDay);

    if (!DEFAULT_TIMES[courseWeekday]) continue;
    if (BIWEEKLY_DAYS.has(courseWeekday) && !isBiweeklyActive(courseDateStr)) continue;

    courses.push({
      date:    courseDateStr,
      day:     dayName(courseWeekday),
      time:    DEFAULT_TIMES[courseWeekday],
      enabled: true,
    });
  }

  return courses;
}

async function updateGist(courses, week) {
  const content = JSON.stringify({ week, courses }, null, 2);
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files: { "schedule.json": { content } } }),
  });
  if (!res.ok) throw new Error(`Gist update failed: ${res.status} ${await res.text()}`);
  console.log("Gist aktualisiert.");
}

async function sendNotification(courses) {
  const lines = courses.map(c => {
    const d = new Date(c.date + "T12:00:00Z");
    const dateFormatted = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
    return `• ${dateFormatted}  ${c.time}`;
  });

  const body = `Diese Woche buchbar:\n${lines.join("\n")}`;
  const pageUrl = "https://christiankohl.github.io/eversports/";

  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: "Kurse diese Woche",
      Actions: `view, Verwalten, ${pageUrl}`,
    },
    body,
  });
  console.log("Notification gesendet.");
}

(async () => {
  const now = new Date();
  const week = weekLabel(now);
  const courses = buildCourses();

  if (courses.length === 0) {
    console.log("Keine Kurse diese Woche (2-Wochen-Rhythmus).");
    process.exit(0);
  }

  console.log("Kurse diese Woche:", courses);
  await updateGist(courses, week);
  await sendNotification(courses);
})();
