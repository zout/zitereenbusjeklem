#!/usr/bin/env node
// Busjesradar: haalt Groningse nieuwsbronnen op, zoekt naar busjes die klem
// zitten onder viaducten/bruggen/tunneltjes en schrijft data/*.json + feed.xml.
// Geen dependencies, draait op Node 18+.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SITE = 'https://zitereenbusjeklem.nl';
const UA = 'Mozilla/5.0 (compatible; Busjesradar/1.0; +https://zitereenbusjeklem.nl)';

const DOWNTIME_HOURS = 4; // een busje klem = 4 uur dicht, in de regel
const CLUSTER_HOURS = 36; // meldingen van hetzelfde punt binnen 36u = één incident

const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=nl&gl=NL&ceid=NL:nl`;

const SOURCES = [
  { id: 'sikkom', naam: 'Sikkom (direct)', url: 'https://www.sikkom.nl/feed/' },
  { id: 'rtvnoord', naam: 'RTV Noord', url: 'https://www.rtvnoord.nl/rss/index.xml' },
  { id: 'oog', naam: 'OOG Groningen', url: 'https://www.oogtv.nl/feed/' },
  ...[
    'busje klem viaduct Groningen',
    'busje vast viaduct Groningen',
    'bestelbus klem viaduct Groningen',
    'bestelwagen klem viaduct Groningen',
    'vrachtwagen klem viaduct Groningen',
    'klem onder viaduct Sikkom',
    'busje klem Sikkom',
    'busje klem Grunn',
    'Pop Dijkemaweg viaduct',
    'Olgerweg viaduct',
    'Emmaviaduct klem',
    'klem onder brug Groningen',
    'klem tunnel Groningen bestelbus',
  ].map((q, i) => ({ id: `gnews-${i}`, naam: `Google Nieuws: "${q}"`, url: gnews(q) })),
];

// Alleen Groningse media tellen mee (Google Nieuws levert ook Aalsmeer en Harmelen).
const GRONINGSE_MEDIA = /sikkom|oog|rtv noord|dvhn|dagblad van het noorden|gic|groninger internet courant|groninger gezinsbode|nieuwsblad van het noorden/i;
const NEEDS_GRONINGEN_WORD = /dvhn|dagblad van het noorden/i; // DvhN doet ook Drenthe
const GRONINGEN_WORD = /groning|grunn|\bstad\b|oosterpark|helpman|hoogkerk|kardinge|lewenborg|beijum|paddepoel|vinkhuizen|selwerd|oosterpoort|korrewegwijk|haren/i;

const VAST = /\bklem|vastgereden|vast te zitten|\bvast\b|vastzit|vastgelopen|ramt|geramd|kapot|aan diggelen|slachtoffer|raak/i;
const OBSTAKEL = /onder (de )?A\d+\b|viaduct|tunnel|onderdoorgang|brug|spoorbrug|hoogteportaal|waarschuwingsbalk|\bbalk\b|overkapping|slagboom|poort/i;
const VOERTUIG = /bus|bestel|bezorg|vrachtw|vrachtauto|camper|truck|koerier|qliner|tractor|verhuis|vuilniswagen|jumbo|albert heijn|picnic|postnl|dhl|boodschappen|pakketje/i;
const GEEN = /schip|boot|vaartuig|stikstof|boeren voeren/i;
const BIJNA = /net op tijd|net niet|bijna|ternauwernood/i;
const NIEUWS = /plaatst|portalen|moet voorkomen|moeten voorkomen|feest|overzicht|vervanging|\?\s*$/i;

const HOTSPOTS = JSON.parse(await readFile(path.join(DATA, 'hotspots.json'), 'utf8'));

function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}

function parseRss(xml, source) {
  const items = [];
  for (const [, it] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    let title = decode(tag(it, 'title')).replace(/^(video|foto'?s?|update)\s*\|\s*/i, '');
    let medium = decode(tag(it, 'source')) || source.naam;
    // Google Nieuws plakt " - Medium" achter de titel
    if (source.id.startsWith('gnews')) {
      const m = title.match(/^(.*) - ([^-]+)$/);
      if (m) [, title, medium] = m;
    }
    const base = {
      link: decode(tag(it, 'link')),
      pubDate: new Date(decode(tag(it, 'pubDate'))).toISOString(),
      beschrijving: decode(tag(it, 'description')).slice(0, 400),
      medium: medium.replace(/ \(direct\)$/, ''),
      bron: source.id,
    };
    // RTV Noord's 112-blog bundelt meldingen met " • "
    for (const part of title.split(' • ')) items.push({ ...base, titel: part.trim() });
  }
  return items;
}

async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { source, items: [], status: `HTTP ${res.status}` };
    const items = parseRss(await res.text(), source);
    return { source, items, status: 'ok' };
  } catch (err) {
    return { source, items: [], status: `fout: ${err.message}` };
  }
}

function classify(item) {
  const t = item.titel;
  const all = `${t} ${item.beschrijving}`;
  if (GEEN.test(t)) return null;
  if (!((VAST.test(t) || BIJNA.test(t)) && OBSTAKEL.test(t) && VOERTUIG.test(all))) return null;
  if (!GRONINGSE_MEDIA.test(item.medium)) return null;
  const hotspot = HOTSPOTS.find((h) => h.match && new RegExp(h.match, 'i').test(all));
  if (!hotspot && NEEDS_GRONINGEN_WORD.test(item.medium) && !GRONINGEN_WORD.test(all)) return null;
  // Alleen titels voor het type: beschrijvingen bevatten vaak 'lees ook'-ruis
  const type = BIJNA.test(t) ? 'bijna' : NIEUWS.test(t) ? 'nieuws' : 'incident';
  return { ...item, hotspot: hotspot ? hotspot.id : 'overig', type };
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9à-ÿ ]/g, '').replace(/\s+/g, ' ').trim();
const idFor = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

function cluster(meldingen) {
  // Eerst meldingen mét locatie, zodat een vage "busje klem in Groningen" van
  // dezelfde dag aan het juiste viaduct wordt gekoppeld.
  meldingen.sort((a, b) => (a.hotspot === 'overig') - (b.hotspot === 'overig') || a.pubDate.localeCompare(b.pubDate));
  const incidents = [];
  for (const m of meldingen) {
    const t = Date.parse(m.pubDate);
    const dichtbij = (inc) => inc.type === m.type && Math.abs(Date.parse(inc.start) - t) < CLUSTER_HOURS * 3600e3;
    const match =
      incidents.find((inc) => dichtbij(inc) && inc.hotspot === m.hotspot && m.hotspot !== 'overig') ||
      (m.hotspot === 'overig' &&
        (incidents.find((inc) => dichtbij(inc) && inc.hotspot !== 'overig') ||
          // twee vage meldingen alleen samen bij (bijna) dezelfde kop
          incidents.find((inc) => dichtbij(inc) && inc.bronnen.some((b) => norm(b.titel) === norm(m.titel)))));
    const bron = { titel: m.titel, medium: m.medium, link: m.link, pubDate: m.pubDate };
    if (match) {
      if (!match.bronnen.some((b) => norm(b.titel) === norm(m.titel) && b.medium === m.medium)) {
        match.bronnen.push(bron);
      }
      if (Date.parse(m.pubDate) < Date.parse(match.start)) match.start = m.pubDate;
      continue;
    }
    incidents.push({
      id: idFor(`${m.hotspot}|${m.pubDate.slice(0, 10)}|${norm(m.titel)}`),
      hotspot: m.hotspot,
      type: m.type,
      titel: m.titel,
      start: m.pubDate,
      eind: m.type === 'incident' ? new Date(t + DOWNTIME_HOURS * 3600e3).toISOString() : null,
      bronnen: [bron],
    });
  }
  for (const inc of incidents) {
    if (inc.eind) inc.eind = new Date(Date.parse(inc.start) + DOWNTIME_HOURS * 3600e3).toISOString();
  }
  return incidents.sort((a, b) => a.start.localeCompare(b.start));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function rss(incidents) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const naam = Object.fromEntries(HOTSPOTS.map((h) => [h.id, h.naam]));
  const items = incidents
    .filter((i) => i.type === 'incident')
    .slice(-50)
    .reverse()
    .map(
      (i) => `    <item>
      <title>${esc(`BUSJE KLEM: ${naam[i.hotspot]} - ${i.titel}`)}</title>
      <link>${esc(i.bronnen[0].link)}</link>
      <guid isPermaLink="false">${i.id}</guid>
      <pubDate>${new Date(i.start).toUTCString()}</pubDate>
      <description>${esc(`${i.bronnen.map((b) => b.medium).join(', ')} meldt: ${i.titel}. Geschatte downtime: ${DOWNTIME_HOURS} uur.`)}</description>
    </item>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Zit er een busje klem? - Busjesalarm Grunn</title>
    <link>${SITE}</link>
    <description>Elk busje dat in Stad of Ommeland klem rijdt onder een viaduct, brug of tunneltje.</description>
    <language>nl</language>
${items}
  </channel>
</rss>
`;
}

const results = await Promise.all(SOURCES.map(fetchSource));
const now = new Date();

const vorige = await readJson('incidents.json', { incidents: [] });
const oudeMeldingen = vorige.incidents.flatMap((inc) =>
  inc.bronnen.map((b) => ({ ...b, hotspot: inc.hotspot, type: inc.type, firstSeen: inc.firstSeen }))
);
const nieuweMeldingen = results.flatMap((r) => r.items).map(classify).filter(Boolean);

// Dedupe op kop+medium, oude data blijft leidend (handmatige correcties blijven staan)
const gezien = new Set();
const meldingen = [];
for (const m of [...oudeMeldingen, ...nieuweMeldingen]) {
  const key = `${norm(m.titel)}|${m.medium}`;
  if (gezien.has(key)) continue;
  gezien.add(key);
  meldingen.push(m);
}

const firstSeen = Object.fromEntries(vorige.incidents.map((i) => [i.id, i.firstSeen]));
const incidents = cluster(meldingen).map((i) => ({ ...i, firstSeen: firstSeen[i.id] || now.toISOString() }));

// Live: begonnen binnen 4 uur, of net door ons ontdekt en van vandaag
// (Google Nieuws geeft oudere Sikkom-stukken vaak alleen een datum).
const live = incidents.filter((i) => {
  if (i.type !== 'incident') return false;
  const age = now - Date.parse(i.start);
  const seenAge = now - Date.parse(i.firstSeen);
  return (age >= 0 && age < DOWNTIME_HOURS * 3600e3) || (seenAge < DOWNTIME_HOURS * 3600e3 && age < 24 * 3600e3);
});

const status = {
  gegenereerd: now.toISOString(),
  downtimeUren: DOWNTIME_HOURS,
  klem: live.length > 0,
  live: live.map((i) => ({ id: i.id, hotspot: i.hotspot, titel: i.titel, start: i.start })),
  bronnen: results.map((r) => ({
    naam: r.source.naam,
    status: r.status,
    items: r.items.length,
  })),
};

await writeFile(
  path.join(DATA, 'incidents.json'),
  JSON.stringify({ gegenereerd: now.toISOString(), downtimeUren: DOWNTIME_HOURS, incidents }, null, 2) + '\n'
);
await writeFile(path.join(DATA, 'status.json'), JSON.stringify(status, null, 2) + '\n');
await writeFile(path.join(ROOT, 'feed.xml'), rss(incidents));

const tel = (t) => incidents.filter((i) => i.type === t).length;
console.log(
  `Busjesradar: ${tel('incident')} incidenten, ${tel('bijna')} bijna-busjes, ${tel('nieuws')} nieuwsitems. ` +
    `Nu klem: ${live.length ? live.map((l) => l.hotspot).join(', ') : 'nee'}`
);
for (const r of results) console.log(`  ${r.status.padEnd(10)} ${String(r.items.length).padStart(3)}  ${r.source.naam}`);
