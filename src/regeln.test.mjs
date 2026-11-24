import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKarte, pruefen, gebot, untergrenze, fristTage, lieferzeit, materialFreigegeben } from './regeln.mjs';

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

test('Materialfreigabe: Faser nur mit eigenem Eintrag, Varianten der Grundsorte zählen mit', () => {
  const liste = ['PLA', 'PETG'];
  assert.equal(materialFreigegeben('PLA', liste), true);
  assert.equal(materialFreigegeben('PLA MATTE', liste), true);
  assert.equal(materialFreigegeben('PETG HF', liste), true);
  assert.equal(materialFreigegeben('PLA-CF', liste), false);
  assert.equal(materialFreigegeben('PETG-GF', liste), false);
  assert.equal(materialFreigegeben('ASA', liste), false);
  assert.equal(materialFreigegeben(null, liste), false);
  assert.equal(materialFreigegeben('PA6-CF', ['PLA', 'PA6-CF']), true);
});

test('ABS wird geboten, TPU nur gemeldet, ASA und Faser bleiben gesperrt', () => {
  const a = parseKarte(karte);
  const abs = pruefen({ ...a, material: 'ABS' }, cfg);
  assert.equal(abs.ok, true, abs.gruende.join(', '));
  assert.equal(abs.nurMelden, false);
  assert.equal(lieferzeit({ ...a, material: 'ABS' }, cfg), 6);
  for (const m of ['TPU', 'TPU 95A']) {
    const tpu = pruefen({ ...a, material: m }, cfg);
    assert.equal(tpu.ok, true, tpu.gruende.join(', '));
    assert.equal(tpu.nurMelden, true);
  }
  assert.equal(pruefen(a, cfg).nurMelden, false);
  assert.equal(pruefen({ ...a, material: 'ASA' }, cfg).ok, false);
  assert.equal(pruefen({ ...a, material: 'ABS-GF' }, cfg).ok, false);
  assert.equal(pruefen({ ...a, material: 'PA6-CF' }, cfg).ok, false);
});

// Nachgebildet nach der Detailseite von Plattform B (24.11.2026), Titel und Nummer erfunden
import { parseDetailB, pruefenB } from './regeln.mjs';
const DETAIL_B = (material2 = 'PETG', material1 = 'TPU') => `XY-1234 · abcd1234
Beispielteil (+2 Teile)
Erstellt: vor 12 Min
Größtes Teil (Teil 3 von 3): 63 × 28 × 130 mm
TEIL 1 VON 3
STL herunterladen
ABMESSUNGEN
23.5 × 23.5 × 9 mm
L × B × H
GEWICHT
~87.4 g
bei ${material1} 100%
VOLUMEN
~1.6 cm³
TEIL 2 VON 3· teil2.stl
STL
ABMESSUNGEN
28 × 28 × 9 mm
VOLUMEN
~1.7 cm³
Material
${material1}
Menge
3
TEIL 3 VON 3· teil3.stl
ABMESSUNGEN
63 × 28 × 130 mm
VOLUMEN
~19.8 cm³
Material
${material2}
Menge
3
DRUCKPARAMETER
Material
${material1}
Menge
3
LIEFERUNG
📦 Versand
Päckchen S (9.19 €)
Express
Nein
DEINE VERGÜTUNG
Herstellkosten inkl. Marge
15.47 €
Versandkosten
9.19 €
Du erhältst
24.66 €
Vergabe in 07:53
Interesse bekunden
Nicht interessiert`;

test('Plattform B: Detailseite wird gelesen', () => {
  const a = parseDetailB(DETAIL_B());
  assert.equal(a.nummer, 'XY-1234');
  assert.equal(a.titel, 'Beispielteil (+2 Teile)');
  assert.deepEqual(a.materialien, ['TPU', 'PETG']);
  assert.equal(a.menge, 3);
  assert.equal(a.herstell_eur, 15.47);
  assert.equal(a.erhaelt_eur, 24.66);
  assert.equal(a.express, false);
  assert.equal(a.hatKnopf, true);
  assert.ok(Math.abs(a.volumen_cm3 - 23.1) < 0.01);
  assert.ok(a.teile_mm.some((t) => t[0] === 23.5 && t[2] === 9));
});

test('Plattform B: TPU nur mit Meldung, PLA/PETG frei, Sondermaterial und Express raus', () => {
  const tpu = pruefenB(parseDetailB(DETAIL_B()), cfg);
  assert.equal(tpu.ok, true);
  assert.equal(tpu.nurMelden, true);
  const frei = pruefenB(parseDetailB(DETAIL_B('PETG', 'PLA')), cfg);
  assert.equal(frei.ok, true);
  assert.equal(frei.nurMelden, false);
  assert.ok(frei.kosten_eur < 15.47);
  assert.equal(pruefenB(parseDetailB(DETAIL_B('PA6-CF', 'PLA')), cfg).ok, false);
  assert.equal(pruefenB(parseDetailB(DETAIL_B('PETG', 'PLA').replace('Express\nNein', 'Express\nJa')), cfg).ok, false);
  const gross = parseDetailB(DETAIL_B('PETG', 'PLA').replace(/63 × 28 × 130 mm/g, '300 × 28 × 130 mm'));
  assert.equal(pruefenB(gross, cfg).ok, false);
});
