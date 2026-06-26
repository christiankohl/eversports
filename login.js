import { chromium } from "playwright";
import fs from "fs";

(async () => {
    const browser = await chromium.launch({
        headless: false, // sichtbar, damit du dich einloggen kannst
        slowMo: 50,      // optional, verlangsamt Aktionen etwas für bessere Übersicht
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Startseite aufrufen
    await page.goto("https://www.eversports.de", { waitUntil: "networkidle" });

    console.log(
        "\nBitte manuell einloggen: navigiere zu /auth, melde dich an und schließe evtl. 2FA ab."
    );

    // Warte 2 Minuten, damit du dich einloggen kannst
    await page.waitForTimeout(2 * 60 * 1000);

    // Speicher die Session inkl. Cookies und LocalStorage
    const state = await context.storageState();
    fs.writeFileSync("auth.json", JSON.stringify(state));

    console.log("\n✅ Login abgeschlossen. Session gespeichert in auth.json");

    await browser.close();
})();