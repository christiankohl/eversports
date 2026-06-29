import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

chromium.use(StealthPlugin());

(async () => {
    const browser = await chromium.launch({
        headless: false,
        channel: "chrome",
        slowMo: 50,
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    await page.goto("https://www.eversports.de", { waitUntil: "domcontentloaded" });

    console.log(
        "\nBitte manuell einloggen: navigiere zu /auth, melde dich an und schließe evtl. 2FA ab."
    );

    // Warte 3 Minuten für Login inkl. evtl. 2FA
    await page.waitForTimeout(3 * 60 * 1000);

    const state = await context.storageState();
    fs.writeFileSync("auth.json", JSON.stringify(state));

    console.log("\n✅ Login abgeschlossen. Session gespeichert in auth.json");

    await browser.close();
})();
