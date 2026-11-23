// Werkbank-Wächter: liest die Auftragsseiten zweier Plattformen, prüft neue Aufträge
// gegen die Regeln und bietet (Testmodus: meldet nur). Adressen kommen aus Umgebungsvariablen.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseKarte, pruefen, gebot, lieferzeit, auftragsId } from './regeln.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const TESTMODUS = process.env.TESTMODUS ? process.env.TESTMODUS !== 'false' : cfg.testmodus;
const NTFY = process.env.NTFY_TOPIC;
const ZIEL_A = (process.env.ZIEL_A || '').replace(/\/$/, ''); // Plattform A (Preis nennen)
const ZIEL_B = (process.env.ZIEL_B || '').replace(/\/$/, ''); // Plattform B (Interesse, Losverfahren)
const BOARD_A = `${ZIEL_A}/auftraege`;
const BOARD_B = `${ZIEL_B}/orders`;
const STAND = 'state/stand.json';

// Dauerlauf: LAUFZEIT_MIN > 0 fragt im Abstand TAKT_S ab, bis die Laufzeit um ist. Ohne Angabe: eine Abfrage.
const LAUFZEIT_MIN = Number(process.env.LAUFZEIT_MIN) || 0;
const TAKT_S = Number(process.env.TAKT_S) || 300;

const stand = existsSync(STAND) ? JSON.parse(readFileSync(STAND, 'utf8')) : { bekannt: {}, gebote: [] };
stand.bekannt ??= {};
stand.gebote ??= [];
stand.meldungen ??= {};
let jetzt = new Date();
const geboteHeute = () => stand.gebote.filter((g) => g.zeit.startsWith(jetzt.toISOString().slice(0, 10))).length;
const log = (...x) => console.log(new Date().toISOString(), ...x);

// drossel_h: dieselbe Meldung (gleicher Titel) höchstens einmal in so vielen Stunden.
async function push(titel, text, { url, prio = 'default', tags = '', drossel_h = 0 } = {}) {
  if (drossel_h) {
    const zuletzt = Date.parse(stand.meldungen[titel] || 0);
    if (Date.now() - zuletzt < drossel_h * 3600000) return log('PUSH gedrosselt', titel);
    stand.meldungen[titel] = new Date().toISOString();
  }
  log('PUSH', titel); // Protokoll ist öffentlich lesbar: kein Auftragstext
  if (!NTFY) return;
  const headers = { Title: encodeURIComponent(titel), Priority: prio, Tags: tags, 'Content-Type': 'text/plain; charset=utf-8' };
  if (url) headers.Click = url;
  await fetch(`https://ntfy.sh/${NTFY}`, { method: 'POST', body: text, headers }).catch((e) => log('Push-Fehler', e.message));
}

function speichern() {
  const grenze = Date.now() - 14 * 86400000;
  for (const [id, t] of Object.entries(stand.bekannt)) if (Date.parse(t) < grenze) delete stand.bekannt[id];
  stand.gebote = stand.gebote.slice(-200);
  mkdirSync('state', { recursive: true });
  writeFileSync(STAND, JSON.stringify(stand, null, 2));
}

function kurz(a) {
  return [
    a.materialZeile,
    a.gewicht_g != null ? `${a.gewicht_g} g` : null,
    a.druckzeit_h != null ? `${a.druckzeit_h.toFixed(1)} h` : null,
    a.masse_mm ? `${a.masse_mm.join('×')} mm` : null,
    a.versand ? 'Versand' : 'Abholung',
    `Frist: ${a.frist ?? '?'}`,
  ].filter(Boolean).join(' · ');
}

const karteVon = (knopf) => knopf.locator('xpath=ancestor::*[.//*[normalize-space()="Gewicht"]][1]');

// ---------------------------------------------------------------- Plattform A
async function plattformA(browser) {
  const auth = 'auth/a.json';
  if (!ZIEL_A || !existsSync(auth)) return log('A: keine Adresse/Sitzung – übersprungen');
  const ctx = await browser.newContext({ storageState: auth, locale: 'de-DE' });
  const page = await ctx.newPage();
  await page.goto(BOARD_A, { waitUntil: 'networkidle' });

  if (!(await page.getByRole('button', { name: /Konto, angemeldet/ }).count())) {
    await push('Werkbank: Anmeldung A abgelaufen', 'Bitte neu anmelden und das Secret A_AUTH erneuern.', { prio: 'high', tags: 'warning', drossel_h: 6 });
    return ctx.close();
  }

  const knoepfe = page.getByRole('button', { name: 'Preis nennen' });
  const n = await knoepfe.count();
  log(`A: ${n} Auftrag/Aufträge mit „Preis nennen“`);

  for (let i = 0; i < n; i++) {
    const knopf = knoepfe.nth(i);
    const a = parseKarte(await karteVon(knopf).innerText());
    const id = auftragsId('a', a);
    if (stand.bekannt[id]) continue;
    stand.bekannt[id] = jetzt.toISOString();

    const r = pruefen(a, cfg);
    if (!r.ok) { log('A: passt nicht –', r.gruende.join('; ')); continue; }
    if (r.nurMelden) {
      await push('Werkbank: Auftrag passt – bitte selbst prüfen', `${a.titel}\n${kurz(a)}\n${cfg.drucker.nur_melden_hinweis ?? ''}`, { url: BOARD_A, tags: 'eyes' });
      continue;
    }
    if (geboteHeute() >= cfg.regeln.max_gebote_pro_tag) {
      await push('Werkbank: Auftrag passt – Tageslimit erreicht', `${a.titel}\n${kurz(a)}`, { url: BOARD_A });
      continue;
    }

    // Ohne gelesenes Gewicht und gelesene Druckzeit wäre der Preis geraten: dann nur melden.
    if (a.gewicht_g == null || a.druckzeit_h == null) {
      await push('Werkbank: Auftrag passt – Daten unvollständig, bitte selbst bieten', kurz(a), { url: BOARD_A, prio: 'high', tags: 'eyes' });
      continue;
    }

    await knopf.click();
    const preisFeld = page.getByLabel('Was du für den Druck erhalten willst');
    await preisFeld.waitFor({ timeout: 10000 });
    const vorbelegt = Number((await preisFeld.inputValue()).replace(',', '.')) || null; // Netto-Höchstpreis des Kunden
    const betrag = gebot(a, cfg, vorbelegt);
    const tage = lieferzeit(a, cfg);
    const betragTxt = betrag.toFixed(2).replace('.', ',');

    if (TESTMODUS) {
      await push(`Werkbank (Test): würde ${betragTxt} € bieten`, `${a.titel}\n${kurz(a)}\nKunde max. netto: ${vorbelegt ?? '?'} € · Lieferzeit ${tage} Tage`, { url: BOARD_A, tags: 'eyes' });
      await page.getByRole('button', { name: 'Schließen' }).first().click().catch(() => {});
      continue;
    }

    await preisFeld.fill(betragTxt);
    await page.getByLabel('Lieferzeit in Tagen').fill(String(tage));
    await page.getByLabel(/Nachricht an den Kunden/).fill(process.env.NACHRICHT || cfg.gebot.nachricht);
    await page.getByRole('button', { name: 'Angebot abgeben' }).click();
    await page.waitForTimeout(3000);
    const fehler = (await page.getByRole('alert').allInnerTexts().catch(() => [])).join(' ').trim();
    if (fehler) {
      await push('Werkbank: Gebot fehlgeschlagen', `${a.titel}\n${fehler}`, { prio: 'high', tags: 'x', url: BOARD_A });
      continue;
    }
    stand.gebote.push({ id, plattform: 'a', titel: a.titel, betrag, zeit: jetzt.toISOString() });
    await push(`Werkbank: Gebot ${betragTxt} € abgegeben`, `${a.titel}\n${kurz(a)}\nLieferzeit ${tage} Tage`, { url: BOARD_A, tags: 'white_check_mark' });
  }

  // Richtpreis-Aufträge: nur melden (Sofortannahme erst nach 3 eigenen abgeschlossenen Aufträgen)
  const annehmen = page.getByRole('button', { name: /^(Annehmen|Auftrag annehmen|Zum Richtpreis annehmen)/ });
  const m = await annehmen.count();
  for (let i = 0; i < m; i++) {
    const a = parseKarte(await karteVon(annehmen.nth(i)).innerText());
    const id = auftragsId('a-rp', a);
    if (stand.bekannt[id]) continue;
    stand.bekannt[id] = jetzt.toISOString();
    if (pruefen(a, cfg).ok) {
      await push(`Werkbank: Richtpreis-Auftrag ${a.richtpreis_eur ?? '?'} € – jetzt annehmen?`, `${a.titel}\n${kurz(a)}`, { url: BOARD_A, prio: 'high', tags: 'zap' });
    }
  }
  await ctx.close();
}

// ---------------------------------------------------------------- Plattform B
// Ablauf: Interesse bekunden → 10-Min.-Fenster → Zufallsvergabe; Preis ist kein Hebel.
// Kartenaufbau noch nicht aufgezeichnet → sucht einen Knopf mit „Interesse“, sonst nur Meldung.
async function plattformB(browser) {
  const auth = 'auth/b.json';
  if (!ZIEL_B || !existsSync(auth)) return log('B: keine Adresse/Sitzung – übersprungen');
  const ctx = await browser.newContext({ storageState: auth, locale: 'de-DE' });
  const page = await ctx.newPage();
  await page.goto(BOARD_B, { waitUntil: 'networkidle' });
  const zaehler = await page.getByText(/^\d+ Aufträge?$/).first().innerText().catch(() => '?');
  log('B:', zaehler);
  if (/^0 /.test(zaehler)) return ctx.close();

  const knoepfe = page.getByRole('button', { name: /Interesse/i });
  const n = await knoepfe.count();
  for (let i = 0; i < n; i++) {
    const karte = knoepfe.nth(i).locator('xpath=ancestor::*[self::article or self::li or contains(@class,"card")][1]');
    const text = (await karte.innerText().catch(() => '')) || '';
    const material = (text.match(/\b(PA6-CF|PA612-CF|PLA|PETG|ABS|ASA|TPU|PA|PC)\b/) || [])[1] || null;
    const a = { titel: text.split('\n')[0] || 'Auftrag B', material, materialZeile: material, frist: null, masse_mm: null, druckzeit_h: null, gewicht_g: text.length };
    const id = auftragsId('b', a);
    if (stand.bekannt[id]) continue;
    stand.bekannt[id] = jetzt.toISOString();
    const r = pruefen(a, cfg);
    if (!r.ok) { log('B: passt nicht –', r.gruende.join('; ')); continue; }
    if (r.nurMelden) {
      await push('Werkbank: B – Auftrag passt, bitte selbst prüfen', `${text.slice(0, 300)}\n${cfg.drucker.nur_melden_hinweis ?? ''}`, { url: BOARD_B, tags: 'eyes' });
      continue;
    }
    if (TESTMODUS) {
      await push('Werkbank (Test): B – würde Interesse bekunden', text.slice(0, 300), { url: BOARD_B, tags: 'eyes' });
      continue;
    }
    if (!cfg.plattform_b_live) { // B ist noch nicht freigegeben: nur melden, das Fenster ist kurz
      await push('Werkbank: B – Auftrag passt, Interesse bitte selbst melden', text.slice(0, 300), { url: BOARD_B, prio: 'high', tags: 'zap' });
      continue;
    }
    await knoepfe.nth(i).click();
    stand.gebote.push({ id, plattform: 'b', titel: a.titel, betrag: null, zeit: jetzt.toISOString() });
    await push('Werkbank: Interesse bei B bekundet', `${text.slice(0, 300)}\nVerlosung in ca. 10 Min.`, { url: BOARD_B, tags: 'game_die' });
  }
  if (n === 0) {
    // Beschriftungen der Knöpfe mitschicken, damit B angeschlossen werden kann (ohne Namen der Seite).
    const stamm = new URL(ZIEL_B).hostname.split('.')[0].toLowerCase();
    const alle = await page.getByRole('button').allInnerTexts().catch(() => []);
    const knopfTexte = [...new Set(alle.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 40 && !t.toLowerCase().includes(stamm)))].slice(0, 15);
    log('B: Knöpfe auf der Seite:', knopfTexte.join(' | ') || '(keine)');
    await push('Werkbank: B hat Aufträge – Knopf nicht erkannt', `${zaehler}. Bitte selbst ansehen.\nKnöpfe: ${knopfTexte.join(' | ') || '(keine)'}`, { url: BOARD_B, prio: 'high', drossel_h: 2 });
  }
  await ctx.close();
}

// ---------------------------------------------------------------- Lauf
async function abfrage() {
  jetzt = new Date();
  const browser = await chromium.launch();
  try {
    await plattformA(browser).catch(async (e) => { log('A-Fehler', e); await push('Werkbank: Fehler A', String(e.message).slice(0, 300), { tags: 'x', drossel_h: 2 }); });
    await plattformB(browser).catch(async (e) => { log('B-Fehler', e); await push('Werkbank: Fehler B', String(e.message).slice(0, 300), { tags: 'x', drossel_h: 2 }); });
  } finally {
    await browser.close().catch(() => {});
    speichern();
  }
}

log(`Modus: ${TESTMODUS ? 'Test (meldet nur)' : `live – A bietet, B ${cfg.plattform_b_live ? 'meldet Interesse' : 'meldet nur'}`}, höchstens ${cfg.regeln.max_gebote_pro_tag} Gebot(e) pro Tag`);
const start = Date.now();
const ende = start + LAUFZEIT_MIN * 60000;
for (let nr = 1; ; nr++) {
  const naechste = start + nr * TAKT_S * 1000;
  log(`Abfrage ${nr}${LAUFZEIT_MIN ? ` (Dauerlauf ${LAUFZEIT_MIN} Min., Takt ${TAKT_S} s)` : ''}`);
  await abfrage().catch((e) => log('Abfrage-Fehler', e));
  if (naechste > ende) break;
  await new Promise((r) => setTimeout(r, Math.max(0, naechste - Date.now())));
}
log('Ende des Laufs');
