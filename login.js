import { chromium } from "playwright";
import fs from "fs";

(async () => {

    const browser = await chromium.launch({
        headless: false
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://www.eversports.de/login");

    console.log("Bitte manuell einloggen...");

    await page.waitForTimeout(60000);

    const state = await context.storageState();

    fs.writeFileSync("auth.json", JSON.stringify(state));

    console.log("Login gespeichert → auth.json");

    await browser.close();

})();