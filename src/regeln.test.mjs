import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKarte, pruefen, gebot, untergrenze, fristTage, lieferzeit } from './regeln.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));

// Nachgebildet nach der Aufzeichnung vom 19.11.2026 (Seite „Offene Aufträge“)
const karte = `Testplatte mit Aussentopf 1x1
Gewicht
142 g geslict
Material
PLA, Farbe egal
Menge und Maße
1 Stück, 206 × 178 × 34,5 mm
Entfernung
etwa 80 km entfernt
Frist
ohne feste Frist
Abholung, Postleitzahlgebiet 06, 3:48 h Druckzeit laut Slicer.
Druckvorgaben des Kunden
Belastung Mittel
Modell in 3D ansehen
12,32 €
erhältst du zum Richtpreis
10,00 € zahlt der Kunde höchstens, mit Versand und Gebühren
Preis nennen`;

test('Karte wird korrekt gelesen', () => {
  const a = parseKarte(karte);
  assert.equal(a.titel, 'Testplatte mit Aussentopf 1x1');
  assert.equal(a.gewicht_g, 142);
  assert.equal(a.material, 'PLA');
  assert.deepEqual(a.masse_mm, [206, 178, 34.5]);
  assert.ok(Math.abs(a.druckzeit_h - 3.8) < 0.01);
  assert.equal(a.versand, false);
  assert.equal(a.richtpreis_eur, 12.32);
  assert.equal(a.kunde_max_brutto_eur, 10);
  assert.equal(a.hatPreisNennen, true);
});

test('Testplatte besteht die Regeln', () => {
  const r = pruefen(parseKarte(karte), cfg);
  assert.equal(r.ok, true, r.gruende.join(', '));
});

test('Gebot liegt bei Falks Handgebot (4,99 €)', () => {
  const a = parseKarte(karte);
  assert.ok(Math.abs(untergrenze(a, cfg) - 3.22) < 0.01);
  assert.equal(gebot(a, cfg, 7.94), 4.99);
  assert.equal(lieferzeit(a, cfg), 3);
});

test('Gebot nie unter Selbstkosten, auch wenn der Kunde weniger zahlt', () => {
  const a = parseKarte(karte);
  assert.equal(gebot(a, cfg, 2.0), 4.99);
});

test('Nach eigenem Gebot wird der Auftrag übersprungen', () => {
  const nachGebot = karte.replace('Gewicht', 'Wartet auf den Kunden\nGewicht').replace('Preis nennen', 'Deinen Preis ansehen');
  const a = parseKarte(nachGebot);
  assert.equal(a.titel, 'Testplatte mit Aussentopf 1x1');
  assert.equal(a.schonGeboten, true);
  assert.equal(pruefen(a, cfg).ok, false);
});

test('Ablehnung: zu groß, zu lang, Resin, knappe Frist', () => {
  const a = parseKarte(karte);
  assert.equal(pruefen({ ...a, masse_mm: [300, 100, 100] }, cfg).ok, false);
  assert.equal(pruefen({ ...a, druckzeit_h: 20 }, cfg).ok, false);
  assert.equal(pruefen({ ...a, material: 'RESIN' }, cfg).ok, false);
  const heute = new Date(2026, 10, 19);
  assert.equal(pruefen({ ...a, frist: 'bis 20.11.' }, cfg, heute).ok, false);
  assert.equal(fristTage('bis 30.11.', heute), 11);
});
