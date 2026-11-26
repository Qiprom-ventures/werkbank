// Werkbank-Wächter: liest die Auftragsseiten zweier Plattformen, prüft neue Aufträge
// gegen die Regeln und bietet (Testmodus: meldet nur). Adressen kommen aus Umgebungsvariablen.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseKarte, pruefen, gebot, lieferzeit, auftragsId, parseDetailB, pruefenB, untergrenze, fristTage } from './regeln.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const TESTMODUS = process.env.TESTMODUS ? process.env.TESTMODUS !== 'false' : cfg.testmodus;
const NTFY = process.env.NTFY_TOPIC;
const ZIEL_A = (process.env.ZIEL_A || '').replace(/\/$/, ''); // Plattform A (Preis nennen)
const ZIEL_B = (process.env.ZIEL_B || '').replace(/\/$/, ''); // Plattform B (Interesse, Losverfahren)
// Der Umkreis steht sonst in einem Cookie der Sitzung; hier fest, damit der Lauf dasselbe sieht wie der Mensch.
const BOARD_A = `${ZIEL_A}/auftraege?umkreis=${cfg.regeln.umkreis_km ?? 500}`;
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
// Zusagen = alles Verbindliche: Gebot (A), Annahme zum Richtpreis (A), Interesse (B). Ein gemeinsames Tageslimit.
const MAX_ZUSAGEN = cfg.regeln.max_zusagen_pro_tag ?? 1;
const zusagenHeute = () => stand.gebote.filter((g) => g.zeit.startsWith(jetzt.toISOString().slice(0, 10))).length;
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

// Jede Karte ist ein Listeneintrag. (Früher: nächster Vorfahr mit „Gewicht“ – das griff bei Karten ohne Gewicht die ganze Liste.)
const karteVon = (knopf) => knopf.locator('xpath=ancestor::li[1]');

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
    if (zusagenHeute() >= MAX_ZUSAGEN) {
      await push('Werkbank: Auftrag passt – Tageslimit erreicht', `${a.titel}\n${kurz(a)}`, { url: BOARD_A });
      continue;
    }

    // Ohne gelesenes Gewicht und gelesene Druckzeit wäre der Preis geraten: dann nur melden.
    const weit = !a.versand && a.entfernung_km != null && a.entfernung_km > (cfg.regeln.max_abholung_km ?? 50);
    if (a.gewicht_g == null || a.druckzeit_h == null || weit) {
      const grund = weit ? `Abholung in ${a.entfernung_km} km` : 'ohne Gewicht/Druckzeit (kein geslictes Modell)';
      log('A: passt, aber nur Meldung –', grund);
      await push('Werkbank: A – Auftrag bitte selbst ansehen', `${a.titel}\n${kurz(a)}\n${grund}`, { url: BOARD_A, prio: 'high', tags: 'eyes' });
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

  // Richtpreis-Aufträge: wer zuerst annimmt, bekommt den Auftrag. Annahme ist sofort verbindlich.
  const rpRegex = /^(Annehmen|Auftrag annehmen|Zum Richtpreis annehmen)/;
  const annehmen = page.getByRole('button', { name: rpRegex });
  const m = await annehmen.count();
  for (let i = 0; i < m; i++) {
    const knopf = annehmen.nth(i);
    const a = parseKarte(await karteVon(knopf).innerText());
    const id = auftragsId('a-rp', a);
    if (stand.bekannt[id]) continue;
    stand.bekannt[id] = jetzt.toISOString();
    const r = pruefen(a, cfg);
    if (!r.ok) { log('A: Richtpreis-Auftrag passt nicht –', r.gruende.join('; ')); continue; }

    const rp = cfg.richtpreis ?? {};
    const ft = fristTage(a.frist, jetzt);
    const kosten = untergrenze(a, cfg);
    const halt = [];
    if (TESTMODUS) halt.push('Testmodus');
    if (!rp.annehmen) halt.push('Annahme ist ausgeschaltet');
    if (a.gewicht_g == null || a.druckzeit_h == null || a.richtpreis_eur == null) halt.push('Gewicht, Druckzeit oder Betrag nicht lesbar');
    if (!a.versand && a.entfernung_km != null && a.entfernung_km > (cfg.regeln.max_abholung_km ?? 50)) halt.push(`Abholung in ${a.entfernung_km} km`);
    if (a.richtpreis_eur != null && rp.max_wert_eur != null && a.richtpreis_eur > rp.max_wert_eur) halt.push(`Betrag über ${rp.max_wert_eur} €`);
    if (a.richtpreis_eur != null && a.richtpreis_eur < kosten) halt.push(`Betrag unter Selbstkosten ${kosten.toFixed(2)} €`);
    if (ft !== null && ft < (rp.min_frist_tage ?? 7)) halt.push(`Frist in ${ft} Tagen`);
    if (zusagenHeute() >= MAX_ZUSAGEN) halt.push('Tageslimit erreicht');
    if (halt.length) {
      log(`A: Richtpreis-Auftrag passt (${a.richtpreis_eur ?? '?'} €), nur Meldung –`, halt.join('; '));
      await push(`Werkbank: Richtpreis-Auftrag ${a.richtpreis_eur ?? '?'} € – jetzt annehmen?`, `${a.titel}\n${kurz(a)}\nNicht selbst angenommen: ${halt.join('; ')}`, { url: BOARD_A, prio: 'high', tags: 'zap' });
      continue;
    }

    await knopf.click();
    await page.waitForTimeout(1500);
    const dialog = page.getByRole('dialog');
    if (await dialog.count()) {
      const stamm = new URL(ZIEL_A).hostname.split('.')[0].toLowerCase();
      const texte = (await dialog.first().getByRole('button').allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 40 && !t.toLowerCase().includes(stamm));
      log('A: Rückfrage der Seite, Knöpfe:', texte.join(' | ') || '(keine)');
      await dialog.first().getByRole('button', { name: /annehmen|bestätigen|verbindlich/i }).first().click({ timeout: 5000 }).catch((e) => log('A: Bestätigen nicht gefunden –', String(e.message).slice(0, 80)));
    }
    await page.waitForTimeout(3000);
    await page.goto(BOARD_A, { waitUntil: 'networkidle' });
    const rest = page.getByRole('button', { name: rpRegex });
    let nochDa = false;
    for (let k = 0, kn = await rest.count(); k < kn; k++) {
      if (auftragsId('a-rp', parseKarte(await karteVon(rest.nth(k)).innerText())) === id) nochDa = true;
    }
    if (nochDa) {
      log(`A: Richtpreis-Auftrag ${a.richtpreis_eur} € – Annahme ohne sichtbare Wirkung`);
      await push('Werkbank: Annahme evtl. nicht angekommen', `${a.titel}\n${kurz(a)}\nBitte selbst ansehen.`, { url: BOARD_A, prio: 'high', tags: 'warning' });
    } else {
      stand.gebote.push({ id, plattform: 'a-rp', titel: a.titel, betrag: a.richtpreis_eur, zeit: jetzt.toISOString() });
      log(`A: Richtpreis-Auftrag ${a.richtpreis_eur} € angenommen (${zusagenHeute()} von ${MAX_ZUSAGEN} heute)`);
      await push(`Werkbank: Auftrag angenommen, ${a.richtpreis_eur} €`, `${a.titel}\n${kurz(a)}\nVerbindlich. Zusage ${zusagenHeute()} von ${MAX_ZUSAGEN} heute.`, { url: BOARD_A, prio: 'high', tags: 'white_check_mark' });
    }
    break; // nach einem Klick ist die Liste neu: Rest in der nächsten Abfrage
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

  // Auf dem Board gibt es keinen Knopf: Jede Karte ist ein Verweis auf die Detailseite, dort steht „Interesse bekunden“.
  const hrefs = await page.locator('main a[href*="/orders/"]').evaluateAll((els) => [...new Set(els.map((x) => x.getAttribute('href')))]);
  if (!hrefs.length) {
    await push('Werkbank: B hat Aufträge – Karte nicht erkannt', `${zaehler}. Bitte selbst ansehen.`, { url: BOARD_B, prio: 'high', drossel_h: 2 });
    return ctx.close();
  }

  for (const href of hrefs) {
    const id = `b-${href.split('/').pop()}`;
    if (stand.bekannt[id]) continue;
    stand.bekannt[id] = jetzt.toISOString();
    const url = new URL(href, ZIEL_B).href;
    const detail = await ctx.newPage();
    try {
      await detail.goto(url, { waitUntil: 'networkidle' });
      const a = parseDetailB(await detail.locator('main').innerText());
      const r = pruefenB(a, cfg);
      const info = `${a.titel}\n${a.materialien.join('+')} · ${a.teile_mm.length} Teil(e) ×${a.menge} · ${a.volumen_cm3.toFixed(1)} cm³ · ${a.versand ? 'Versand' : 'Abholung'}\nVergütung ${a.herstell_eur ?? '?'} € (Selbstkosten ca. ${r.kosten_eur} €), du erhältst ${a.erhaelt_eur ?? '?'} €`;
      if (!r.ok) { log(`B: ${a.nummer ?? id} passt nicht –`, r.gruende.join('; ')); continue; }
      if (!a.hatKnopf) { log(`B: ${a.nummer ?? id} passt, aber kein Knopf (schon gemeldet oder vergeben)`); continue; }
      if (r.nurMelden) {
        log(`B: ${a.nummer ?? id} passt, Material nur mit Meldung`);
        await push('Werkbank: B – Auftrag passt, bitte selbst prüfen', `${info}\n${cfg.drucker.nur_melden_hinweis ?? ''}`, { url, prio: 'high', tags: 'eyes' });
        continue;
      }
      if (TESTMODUS) {
        await push('Werkbank (Test): B – würde Interesse bekunden', info, { url, tags: 'eyes' });
        continue;
      }
      if (!cfg.plattform_b_live) { // B ist noch nicht freigegeben: nur melden, das Fenster ist kurz
        log(`B: ${a.nummer ?? id} passt, B meldet nur`);
        await push('Werkbank: B – Auftrag passt, Interesse bitte selbst melden', info, { url, prio: 'high', tags: 'zap' });
        continue;
      }
      if (zusagenHeute() >= MAX_ZUSAGEN) {
        await push('Werkbank: B – Auftrag passt, Tageslimit erreicht', info, { url, prio: 'high' });
        continue;
      }
      if (!r.farbeOk) {
        log(`B: ${a.nummer ?? id} passt, Farbe vorgegeben – nur Meldung`);
        await push('Werkbank: B – Auftrag passt, Farbe vorgegeben, bitte selbst melden', `${info}\nFarbe: ${a.farben.join(', ') || '?'}`, { url, prio: 'high', tags: 'zap' });
        continue;
      }
      const knopfB = detail.getByRole('button', { name: 'Interesse bekunden' });
      await knopfB.click();
      // Falls die Seite nachfragt: bestätigen. Dann bis zu 10 s warten, ob der Knopf verschwindet.
      await detail.waitForTimeout(1200);
      const stammB = new URL(ZIEL_B).hostname.split('.')[0].toLowerCase();
      const sauber = (liste) => [...new Set(liste.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 40 && !t.toLowerCase().includes(stammB)))].slice(0, 12);
      // Die Seite fragt nach: „Abbrechen | Ja, Interesse bekunden“ (kein eigenes Dialogfenster, gesehen am 24.11.2026).
      // Nur den sichtbaren Knopf nehmen; es kann eine verdeckte Kopie geben (25.11.2026: Klick lief 5 s ins Leere).
      const ja = detail.getByRole('button', { name: /^Ja, Interesse bekunden/ }).filter({ visible: true });
      let bestaetigt = false;
      // Vor dem Bestätigen muss das Häkchen „Material und Farbe vorrätig“ gesetzt sein, sonst ist „Ja“ gesperrt (26.11.2026).
      const haken = detail.locator('input[type="checkbox"]').filter({ visible: true });
      if (await haken.count()) {
        await haken.last().check({ timeout: 5000 }).then(() => log('B: Häkchen Material/Farbe gesetzt')).catch((e) => log('B: Häkchen nicht gesetzt –', String(e.message).slice(0, 120)));
      } else {
        log('B: kein Häkchen in der Rückfrage gefunden');
      }
      if (await ja.count()) {
        const info = await ja.first().evaluate((el) => ({ aus: el.disabled, n: document.querySelectorAll('button').length })).catch(() => ({}));
        if (info.aus) log('B: Bestätigen-Knopf ist gesperrt');
        await ja.first().scrollIntoViewIfNeeded().catch(() => {});
        await ja.first().click({ timeout: 8000 }).then(() => { bestaetigt = true; }).catch(async (e) => {
          log('B: Bestätigen fehlgeschlagen –', String(e.message).split('\n').slice(0, 3).join(' / ').slice(0, 300));
          // Zweiter Versuch ohne Wartebedingungen, falls ein Overlay den Klick abfängt
          await ja.first().click({ timeout: 3000, force: true }).then(() => { bestaetigt = true; log('B: Bestätigen im zweiten Versuch'); }).catch(() => {});
        });
        await ja.first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
      } else {
        log(`B: ${a.nummer ?? id} keine Rückfrage gefunden`);
      }
      await detail.waitForTimeout(1500);
      const nachher = await detail.locator('main').innerText().catch(() => '');
      const zustand = (nachher.match(/Interesse (bekundet|zurückziehen|angemeldet|vorgemerkt)[^\n]{0,30}|Du bist dabei[^\n]{0,30}|Vergabe in \d\d:\d\d/gi) || []).slice(0, 4).join(' / ');
      log(`B: ${a.nummer ?? id} nach dem Klick – Knöpfe:`, sauber(await detail.locator('main').getByRole('button').allInnerTexts().catch(() => [])).join(' | ') || '(keine)', '– Zustand:', zustand || '(nichts erkannt)');
      const rueckfrageOffen = (await ja.count()) > 0;
      const erkannt = /zurückziehen|bekundet|vorgemerkt|angemeldet|du bist dabei/i.test(nachher);
      if (!erkannt && (!bestaetigt || rueckfrageOffen)) {
        log(`B: ${a.nummer ?? id} Klick ohne sichtbare Wirkung`);
        await push('Werkbank: B – Interesse evtl. nicht angekommen', info, { url, prio: 'high', tags: 'warning' });
        continue;
      }
      stand.gebote.push({ id, plattform: 'b', titel: a.nummer ?? a.titel, betrag: a.herstell_eur, zeit: jetzt.toISOString() });
      log(`B: ${a.nummer ?? id} Interesse bekundet`);
      await push('Werkbank: Interesse bei B bekundet', `${info}\nDie Vergabe erfolgt per Los.`, { url, tags: 'game_die' });
    } catch (e) {
      log('B: Fehler bei einem Auftrag –', String(e.message).slice(0, 120));
      await push('Werkbank: B – Auftrag konnte nicht gelesen werden', 'Bitte selbst ansehen.', { url: BOARD_B, prio: 'high', drossel_h: 1 });
    } finally {
      await detail.close().catch(() => {});
    }
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

log(`Modus: ${TESTMODUS ? 'Test (meldet nur)' : `live – A bietet, B ${cfg.plattform_b_live ? 'meldet Interesse' : 'meldet nur'}`}, Richtpreis ${cfg.richtpreis?.annehmen ? 'wird angenommen' : 'nur Meldung'}, höchstens ${MAX_ZUSAGEN} Zusage(n) pro Tag`);
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
