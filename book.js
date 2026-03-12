import { chromium } from "playwright";

const URL = "https://www.eversports.de/st/crossfit-kur-pals";

const GROUP_ID = "71206";

const TARGET_TIME = "17:00";

function getTargetDate() {

    const d = new Date();

    d.setDate(d.getDate() + 5);

    return d.toISOString().split("T")[0];

}

async function waitForRelease() {

    const now = new Date();

    const target = new Date();

    target.setHours(17);
    target.setMinutes(0);
    target.setSeconds(0);
    target.setMilliseconds(0);

    if (now < target) {

        const diff = target - now;

        console.log("Warte bis Release:", diff / 1000, "Sekunden");

        await new Promise(r => setTimeout(r, diff));

    }

}

(async () => {

    const browser = await chromium.launch({
        headless: true
    });

    const context = await browser.newContext({
        storageState: "auth.json"
    });

    const page = await context.newPage();

    await page.goto(URL);

    await page.waitForSelector(".calendar__day");

    const targetDate = getTargetDate();

    console.log("Ziel-Datum:", targetDate);

    let header = page.locator(`h3[data-day="${targetDate}"]`);

    if (await header.count() === 0) {

        console.log("Datum nicht sichtbar → nächste Woche");

        await page.getByTestId("show-next-week-action").click();

        await page.waitForTimeout(1500);

    }

    const day = page.locator(`.calendar__day:has(h3[data-day="${targetDate}"])`);

    const slot = day.locator(
        `li[data-group-id="${GROUP_ID}"]`,
        { has: page.locator(`.session-time:has-text("${TARGET_TIME}")`) }
    );

    await waitForRelease();

    console.log("Suche Slot...");

    let found = false;

    for (let i = 0; i < 10; i++) {

        if (await slot.count() > 0) {

            found = true;

            break;

        }

        console.log("Slot noch nicht sichtbar, retry...");

        await page.waitForTimeout(500);

    }

    if (!found) {

        console.log("Slot nicht gefunden");

        await browser.close();

        return;

    }

    if (await slot.locator("text=ausgebucht").count() > 0) {

        console.log("Slot ist ausgebucht");

        await browser.close();

        return;

    }

    console.log("Slot gefunden → klicken");

    await slot.click();

    const button = page.getByRole("button", { name: /buchen/i });

    await button.click();

    console.log("Buchung ausgelöst");

    await page.waitForTimeout(3000);

    await browser.close();

})();