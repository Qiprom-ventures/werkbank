// Einmalig lokal ausführen: ZIEL_A=https://… ZIEL_B=https://… npm run anmelden
// Öffnet ein Browserfenster, du meldest dich selbst an, die Sitzung landet in auth/a.json bzw. auth/b.json.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import readline from 'node:readline/promises';

const ziele = [
  { name: 'a', url: process.env.ZIEL_A && `${process.env.ZIEL_A.replace(/\/$/, '')}/auftraege` },
  { name: 'b', url: process.env.ZIEL_B && `${process.env.ZIEL_B.replace(/\/$/, '')}/orders` },
].filter((z) => z.url);
if (!ziele.length) { console.error('Bitte ZIEL_A und/oder ZIEL_B setzen.'); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
mkdirSync('auth', { recursive: true });
const browser = await chromium.launch({ headless: false });
for (const z of ziele) {
  const ctx = await browser.newContext({ locale: 'de-DE' });
  const page = await ctx.newPage();
  await page.goto(z.url);
  await rl.question(`\n${z.name.toUpperCase()}: Bitte im Fenster anmelden. Wenn die Auftragsseite angemeldet zu sehen ist, hier Enter drücken … `);
  await ctx.storageState({ path: `auth/${z.name}.json` });
  console.log(`Gespeichert: auth/${z.name}.json`);
  await ctx.close();
}
await browser.close();
rl.close();
