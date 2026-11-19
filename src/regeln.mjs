// Reine Prüf- und Preislogik – ohne Browser, damit testbar.

const zahl = (s) => (s == null ? null : Number(String(s).replace(/\./g, '').replace(',', '.')));

/** Liest den Text einer Auftragskarte (Plattform A, Seite „Offene Aufträge“) in ein Objekt. */
export function parseKarte(text) {
  const t = text.replace(/ /g, ' ');
  const zeilen = t.split('\n').map((z) => z.trim()).filter(Boolean);
  const nach = (label) => {
    const i = zeilen.findIndex((z) => z === label);
    return i >= 0 ? zeilen[i + 1] : null;
  };
  const zeit = t.match(/(\d+):(\d{2})\s*h\s*Druckzeit/i);
  const masse = t.match(/(\d+)\s*Stück,\s*([\d.,]+)\s*×\s*([\d.,]+)\s*×\s*([\d.,]+)\s*mm/);
  const materialZeile = nach('Material') || '';
  return {
    titel: zeilen[0] || '(ohne Titel)',
    gewicht_g: zahl(t.match(/([\d.,]+)\s*g\s*geslict/i)?.[1]),
    druckzeit_h: zeit ? Number(zeit[1]) + Number(zeit[2]) / 60 : null,
    material: materialZeile.split(',')[0].trim().toUpperCase() || null,
    materialZeile,
    stueck: masse ? Number(masse[1]) : 1,
    masse_mm: masse ? [zahl(masse[2]), zahl(masse[3]), zahl(masse[4])] : null,
    frist: nach('Frist'),
    versand: !/^Abholung/m.test(t),
    richtpreis_eur: zahl(t.match(/([\d.,]+)\s*€\s*erhältst du zum Richtpreis/)?.[1]),
    kunde_max_brutto_eur: zahl(t.match(/([\d.,]+)\s*€\s*zahlt der Kunde höchstens/)?.[1]),
    hatPreisNennen: /Preis nennen/.test(t),
    schonGeboten: /Wartet auf den Kunden|Deinen Preis ansehen|erhältst du mit deinem Preis|Angebot zurückziehen/i.test(t),
  };
}

/** Tage bis zur Frist; null = keine feste Frist; NaN = nicht lesbar. */
export function fristTage(frist, heute = new Date()) {
  if (!frist || /ohne feste Frist/i.test(frist)) return null;
  const m = frist.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
  if (!m) return NaN;
  const jahr = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : heute.getFullYear();
  let d = new Date(jahr, Number(m[2]) - 1, Number(m[1]));
  if (!m[3] && d < heute) d = new Date(jahr + 1, Number(m[2]) - 1, Number(m[1]));
  return Math.floor((d - heute) / 86400000);
}

export function passtInBauraum(masse, bauraum) {
  if (!masse) return true; // Plattform A filtert „Passt zu meinen Druckern“ bereits
  const a = [...masse].sort((x, y) => y - x);
  const b = [...bauraum].sort((x, y) => y - x);
  return a.every((v, i) => v <= b[i]);
}

const FASER = /(CF|GF)/;

/** Freigabe: Faser-Filamente nur mit eigenem Faser-Eintrag, sonst Präfix der Grundsorte (PLA MATTE → PLA). */
export function materialFreigegeben(material, liste) {
  if (!material) return false;
  const faser = FASER.test(material);
  return liste.some((m) => FASER.test(m) === faser && material.startsWith(m));
}

export function materialKlasse(material) {
  if (!material) return 'standard';
  if (/CF/.test(material)) return 'CF';
  const basis = material.replace(/[^A-Z]/g, '');
  return ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'].includes(basis) ? basis : 'standard';
}

/** Selbstkosten-Untergrenze in € für den ganzen Auftrag (Gewicht = geslictes Gesamtgewicht). */
export function untergrenze(a, cfg) {
  const p = cfg.preis;
  const eurG = p.material_eur_pro_g[materialKlasse(a.material)] ?? p.material_eur_pro_g.standard;
  return (a.gewicht_g ?? 0) * eurG + (a.druckzeit_h ?? 0) * p.strom_eur_pro_h + (a.versand ? p.verpackung_eur_versand : 0);
}

/** Gebot (netto, „was du erhalten willst“): Selbstkosten + Aufschlag, gerundet auf x,49 / x,99.
 *  Liegt der Netto-Höchstpreis des Kunden darunter, aber noch über den Selbstkosten, wird er übernommen. */
export function gebot(a, cfg, kundeMaxNetto = null) {
  const kosten = untergrenze(a, cfg);
  const roh = kosten + cfg.preis.aufschlag_eur;
  let g = Math.ceil(roh * 2) / 2 - 0.01;
  if (g < roh) g += 0.5;
  if (kundeMaxNetto != null && kundeMaxNetto >= kosten && g > kundeMaxNetto) g = kundeMaxNetto;
  return Math.round(g * 100) / 100;
}

/** Prüft einen Auftrag gegen die Regeln. Ergebnis: { ok, gruende[] } */
export function pruefen(a, cfg, heute = new Date()) {
  const gr = [];
  if (!materialFreigegeben(a.material, cfg.drucker.materialien)) gr.push(`Material ${a.material ?? '?'} nicht für X2D freigegeben`);
  if (!passtInBauraum(a.masse_mm, cfg.drucker.bauraum_mm)) gr.push('passt nicht in den Bauraum');
  if (a.druckzeit_h != null && a.druckzeit_h > cfg.regeln.max_druckzeit_h) gr.push(`Druckzeit ${a.druckzeit_h.toFixed(1)} h > ${cfg.regeln.max_druckzeit_h} h`);
  const ft = fristTage(a.frist, heute);
  if (Number.isNaN(ft)) gr.push(`Frist nicht lesbar: ${a.frist}`);
  else if (ft !== null && ft < cfg.regeln.min_frist_tage) gr.push(`Frist zu knapp (${ft} Tage)`);
  if (a.schonGeboten) gr.push('bereits geboten');
  return { ok: gr.length === 0, gruende: gr };
}

export function lieferzeit(a, cfg) {
  return ['PLA', 'PETG'].includes(materialKlasse(a.material))
    ? cfg.gebot.lieferzeit_tage_standard
    : cfg.gebot.lieferzeit_tage_sondermaterial;
}

export function auftragsId(plattform, a) {
  const s = `${plattform}|${a.titel}|${a.gewicht_g}|${(a.masse_mm || []).join('x')}|${a.materialZeile ?? a.material}`;
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${plattform}-${h.toString(36)}`;
}
