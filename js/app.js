/* zitereenbusjeklem.nl — de busjesradar in de browser.
   Leest data/*.json (bijgewerkt door scraper/scrape.mjs) en tekent alles. */
(function () {
  'use strict';

  const UUR = 3600e3;
  const DAG = 24 * UUR;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (n, d = 0) => n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
  const datum = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(iso).toLocaleDateString('nl-NL', opts);

  const POSTMORTEMS = [
    'Chauffeur dacht: dat past wel.',
    'Navigatie zei rechtdoor. Viaduct zei nee.',
    'Hoogtebord gezien, maar als advies opgevat.',
    'Busje bleek hoger dan gehoopt. Viaduct lager dan verwacht.',
    'Lading: pakketjes en een flinke dosis optimisme.',
    'Hai har t nait goud inschat.',
    'Waarschuwingsbalk werd gezien als een suggestie.',
    'Chauffeur kwam uit de Randstad en kende de lokale gebruiken nog niet.',
    'Root cause: fysica. Contributing factor: haast.',
    'Er werd gezegd "t gaat net". Het ging net niet.',
    'Imperial units in de cabine, metrisch viaduct.',
    'Dak van t busje is nu een cabrio. Klant tevreden?',
    'Viaduct deed precies wat het al jaren doet.',
    'Hoogteportaal genegeerd met de moed der wanhoop.',
    't Is nait aans.',
  ];
  const BIJNA_PM = ['Remmen bleken het beste onderdeel van dit busje.', 'Net op tijd gezien. Applaus vanaf de stoep.', 'De waarschuwingsbalk heeft zijn werk gedaan. Eén keer.'];
  const NIEUWS_PM = ['Beleid! Spannend.', 'Nieuws over de viaductenfront.', 'De gemeente roert zich.'];

  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const postmortem = (inc) => {
    const lijst = inc.type === 'bijna' ? BIJNA_PM : inc.type === 'nieuws' ? NIEUWS_PM : POSTMORTEMS;
    return lijst[hash(inc.id) % lijst.length];
  };

  const DREIGING = ['Minimaal', 'Beperkt', 'Aanzienlijk', 'Substantieel', 'KRITIEK'];

  async function laad(url) {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  async function start() {
    let hotspots, data, status;
    try {
      [hotspots, data, status] = await Promise.all([laad('data/hotspots.json'), laad('data/incidents.json'), laad('data/status.json')]);
    } catch (err) {
      $('#antwoord').textContent = '???';
      $('#antwoord-sub').textContent = 'De busjesradar is zelf klem komen te zitten. Probeer t straks nog es.';
      console.error(err);
      return;
    }
    const now = Date.now();
    const byId = Object.fromEntries(hotspots.map((h) => [h.id, h]));
    const incidents = data.incidents.map((i) => ({ ...i, t0: Date.parse(i.start), t1: i.eind ? Date.parse(i.eind) : null }));
    const klem = incidents.filter((i) => i.type === 'incident');
    const liveIds = new Set(status.live.map((l) => l.id));

    const ctx = { now, hotspots, byId, incidents, klem, liveIds, status, downtime: data.downtimeUren || 4 };
    tekenAntwoord(ctx);
    tekenTicker(ctx);
    tekenStats(ctx);
    tekenKaart(ctx);
    tekenHotspots(ctx);
    tekenUptime(ctx);
    tekenIncidenten(ctx);
    tekenPers(ctx);
    tekenBronnen(ctx);
  }

  /* ---------- Het grote antwoord ---------- */
  function tekenAntwoord({ status, byId, klem, now }) {
    const el = $('#antwoord');
    const sub = $('#antwoord-sub');
    $('#gegenereerd').textContent = new Date(status.gegenereerd).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
    $('#voet-bijgewerkt').textContent = datum(status.gegenereerd);
    if (status.klem) {
      const waar = [...new Set(status.live.map((l) => byId[l.hotspot]?.naam || 'ergens in Stad'))].join(' én ');
      el.textContent = 'JOA!!!';
      el.className = 'antwoord joa';
      sub.innerHTML = `🚨 Er zit op dit moment een busje klem bij <u>${esc(waar)}</u>! Rij om, of kom kieken. 🚨`;
      document.body.classList.add('alarm');
      document.title = '🚨 JOA! Er zit een busje klem! | zitereenbusjeklem.nl';
      busjesregen(30);
    } else {
      const laatste = klem[klem.length - 1];
      el.textContent = 'NEE.';
      el.className = 'antwoord nee';
      sub.innerHTML = laatste
        ? `Dr zit op dit moment gain busje klem. Nog nait. Het laatste busje strandde ${tijdGeleden(now - laatste.t0)} ${laatste.hotspot === 'overig' ? 'ergens in Stad of Ommeland' : `bij <b>${esc(byId[laatste.hotspot]?.naam)}</b>`}: <a href="${esc(laatste.bronnen[0].link)}" target="_blank" rel="noopener">"${esc(laatste.titel)}"</a>`
        : 'Dr zit op dit moment gain busje klem. Nog nait.';
      document.title = 'NEE. (nog nait) | zitereenbusjeklem.nl';
    }
  }

  function tijdGeleden(ms) {
    const d = Math.floor(ms / DAG);
    const u = Math.floor((ms % DAG) / UUR);
    if (d === 0) return `${u} uur geleden`;
    return `${d} ${d === 1 ? 'dag' : 'dagen'} en ${u} uur geleden`;
  }

  /* ---------- Ticker ---------- */
  function tekenTicker({ incidents, byId }) {
    const items = incidents.slice(-12).reverse().map((i) => {
      const b = i.bronnen[0];
      const icoon = i.type === 'incident' ? '💥' : i.type === 'bijna' ? '😅' : '📰';
      return `${icoon} <a href="${esc(b.link)}" target="_blank" rel="noopener">${esc(datum(i.start))} · ${esc(byId[i.hotspot]?.naam)} · ${esc(i.titel)} (${esc(b.medium)})</a>`;
    });
    $('#ticker').innerHTML = items.join(' &nbsp;&nbsp;★&nbsp;&nbsp; ') + ' &nbsp;&nbsp;★&nbsp;&nbsp; 🚐 Hoogte checken = leven redden 🚐';
  }

  /* ---------- Fabrieksbord + stats ---------- */
  function tekenStats({ klem, now, downtime }) {
    const laatste = klem[klem.length - 1];
    const dagenZonder = laatste ? Math.floor((now - laatste.t1) / DAG) : 0;
    $('#dagen-zonder').textContent = Math.max(0, dagenZonder);

    let record = 0;
    for (let i = 1; i < klem.length; i++) record = Math.max(record, (klem[i].t0 - klem[i - 1].t1) / DAG);
    record = Math.max(record, dagenZonder);
    $('#record-zonder').textContent = nl(Math.floor(record));

    $('#stat-totaal').textContent = klem.length;
    $('#stat-uren').textContent = nl(klem.length * downtime);

    const drieJaar = klem.filter((i) => i.t0 > now - 3 * 365 * DAG);
    const mtbb = drieJaar.length > 1 ? (drieJaar[drieJaar.length - 1].t0 - drieJaar[0].t0) / DAG / (drieJaar.length - 1) : null;
    $('#stat-mtbb').textContent = mtbb ? nl(mtbb) : '∞';

    const jaar = new Date(now).getFullYear();
    $('#stat-jaar').textContent = klem.filter((i) => new Date(i.t0).getFullYear() === jaar).length;
    $('#stat-jaar-label').textContent = String(jaar);

    // teller in de footer: oldskool odometer
    const teller = $('#teller');
    let n = 0;
    const doel = klem.length;
    const iv = setInterval(() => {
      n = Math.min(doel, n + 1);
      teller.textContent = String(n).padStart(6, '0');
      if (n >= doel) clearInterval(iv);
    }, 60);
    $('#jaar').textContent = jaar;
  }

  /* ---------- Hotspot-statistieken ---------- */
  function hotspotStats(h, { klem, incidents, now, liveIds }) {
    const eigen = klem.filter((i) => i.hotspot === h.id);
    const laatste = eigen[eigen.length - 1];
    const jaar = eigen.filter((i) => i.t0 > now - 365 * DAG).length;
    return {
      eigen,
      totaal: eigen.length,
      jaar,
      laatste,
      bijna: incidents.filter((i) => i.hotspot === h.id && i.type === 'bijna').length,
      live: eigen.some((i) => liveIds.has(i.id)),
      dreiging: Math.min(5, jaar === 0 ? (eigen.length ? 1 : 0) : jaar + 1),
    };
  }

  /* ---------- Kaart ---------- */
  function tekenKaart(ctx) {
    if (!window.L) {
      $('#kaart').innerHTML = '<p style="padding:20px">De kaart kon nait laden. Te laag viaduct op de route, vermoedelijk.</p>';
      return;
    }
    const kaart = L.map('kaart', { scrollWheelZoom: false }).setView([53.2165, 6.585], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(kaart);
    const punten = [];
    for (const h of ctx.hotspots) {
      if (h.lat == null) continue;
      const s = hotspotStats(h, ctx);
      const maat = 30 + s.totaal * 8;
      const icon = L.divIcon({
        className: '',
        html: `<div class="busje-marker${s.live ? ' live' : ''}" style="width:${maat}px;height:${maat}px">🚐</div>`,
        iconSize: [maat, maat],
        iconAnchor: [maat / 2, maat / 2],
      });
      L.marker([h.lat, h.lon], { icon, title: h.naam })
        .addTo(kaart)
        .bindPopup(
          `<b>${esc(h.naam)}</b><br><i>"${esc(h.bijnaam)}"</i><br>` +
            `💥 ${s.totaal} busjes klem · 😅 ${s.bijna} bijna<br>` +
            (s.laatste ? `Laatste: ${esc(datum(s.laatste.start))}<br>` : '') +
            `<small>${esc(h.wijk)}</small>` +
            (s.live ? '<br><b style="color:red">🚨 NU KLEM! 🚨</b>' : '')
        );
      punten.push([h.lat, h.lon]);
    }
    // Opnieuw passend maken zodra de kaart echt een maat heeft (verborgen tab, lazy layout)
    const pas = () => {
      kaart.invalidateSize();
      if (punten.length) kaart.fitBounds(punten, { padding: [30, 30], maxZoom: 14 });
    };
    pas();
    let vorigeBreedte = 0;
    new ResizeObserver(([e]) => {
      if (Math.abs(e.contentRect.width - vorigeBreedte) > 20) { vorigeBreedte = e.contentRect.width; pas(); }
    }).observe($('#kaart'));
  }

  /* ---------- Hall of Shame ---------- */
  function tekenHotspots(ctx) {
    const rij = ctx.hotspots
      .map((h) => ({ h, s: hotspotStats(h, ctx) }))
      // "Elders" is geen viaduct en doet niet mee om de beker; die sluit de rij
      .sort((a, b) => (a.h.id === 'overig') - (b.h.id === 'overig') || b.s.totaal - a.s.totaal || (b.s.laatste?.t0 || 0) - (a.s.laatste?.t0 || 0));
    const klassen = ['goud', 'zilver', 'brons'];
    $('#hotspot-lijst').innerHTML = rij
      .map(({ h, s }, i) => {
        const lvl = s.dreiging;
        return `<article class="hotspot ${h.id === 'overig' ? '' : klassen[i] || ''}">
          <div class="hotspot-rang">${h.id === 'overig' ? '?' : `#${i + 1}`}</div>
          <h3>${esc(h.naam)}</h3>
          <p class="bijnaam">"${esc(h.bijnaam)}"</p>
          <div class="teller-groot">${s.totaal}×</div>
          <div class="meta">💥 busjes klem · 😅 ${s.bijna} bijna-busje${s.bijna === 1 ? '' : 's'}<br>
            📍 ${esc(h.wijk)}<br>
            🕐 Laatste: ${s.laatste ? esc(datum(s.laatste.start)) : 'nog nooit (verdacht)'}</div>
          <p class="weetje">💡 ${esc(h.weetje)}</p>
          <div class="dreiging">Dreigingsniveau: ${lvl ? DREIGING[lvl - 1] : 'Geen'} ${s.live ? '🚨 NU KLEM' : ''}
            <div class="dreiging-balk">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= lvl ? 'aan' : ''}"></i>`).join('')}</div>
          </div>
        </article>`;
      })
      .join('');
  }

  /* ---------- Uptime ---------- */
  function downtimeIn(eigen, van, tot) {
    let ms = 0;
    for (const i of eigen) ms += Math.max(0, Math.min(i.t1, tot) - Math.max(i.t0, van));
    return ms;
  }
  const pct = (down, periode) => (100 * (1 - down / periode));
  const fmtPct = (p) => (p >= 100 ? '100%' : `${p.toFixed(p > 99.9 ? 3 : 2).replace('.', ',')}%`);

  function tekenUptime(ctx) {
    const { now, incidents } = ctx;
    const eerste = ctx.klem.length ? ctx.klem[0].t0 : now - 365 * DAG;
    const vandaag = new Date(now);
    vandaag.setHours(0, 0, 0, 0);
    const dagStart = vandaag.getTime() - 89 * DAG;

    const rijen = ctx.hotspots.map((h) => {
      const s = hotspotStats(h, ctx);
      const bijna = incidents.filter((i) => i.hotspot === h.id && i.type === 'bijna');
      const u30 = pct(downtimeIn(s.eigen, now - 30 * DAG, now), 30 * DAG);
      const u90 = pct(downtimeIn(s.eigen, now - 90 * DAG, now), 90 * DAG);
      const u365 = pct(downtimeIn(s.eigen, now - 365 * DAG, now), 365 * DAG);
      const uAll = pct(downtimeIn(s.eigen, eerste, now), now - eerste);
      const blokken = [];
      for (let d = 0; d < 90; d++) {
        const a = dagStart + d * DAG;
        const b = a + DAG;
        const hit = s.eigen.filter((i) => i.t0 < b && i.t1 > a);
        const bh = bijna.filter((i) => i.t0 >= a && i.t0 < b);
        const label = new Date(a).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
        if (hit.length) blokken.push(`<i class="down" title="${label}: busje klem! ${esc(hit[0].titel)}"></i>`);
        else if (bh.length) blokken.push(`<i class="bijna" title="${label}: bijna-busje. ${esc(bh[0].titel)}"></i>`);
        else blokken.push(`<i title="${label}: doorgang vrij"></i>`);
      }
      return { h, s, u30, u90, u365, uAll, blokken };
    });

    const live = rijen.filter((r) => r.s.live);
    const sys = $('#systeemstatus');
    if (live.length) {
      sys.className = 'systeemstatus storing';
      sys.textContent = `🔴 STORING: ${live.map((r) => r.h.naam).join(', ')} — busje klem, verwachte hersteltijd ±${ctx.downtime} uur`;
    } else {
      const totaal90 = rijen.reduce((s, r) => s + r.u90, 0) / rijen.length;
      sys.textContent = `🟢 Alle doorgangen operationeel · Gemiddelde uptime 90 dagen: ${fmtPct(totaal90)}`;
    }

    $('#uptime-lijst').innerHTML = rijen
      .map(
        (r) => `<div class="uptime-rij">
        <div class="uptime-top">
          <span class="uptime-naam">${esc(r.h.naam)}</span>
          <span class="uptime-pil ${r.s.live ? 'down' : ''}">${r.s.live ? 'BUSJE KLEM' : 'Operationeel'}</span>
          <span class="uptime-nummers">
            <span>30d <b>${fmtPct(r.u30)}</b></span>
            <span>90d <b>${fmtPct(r.u90)}</b></span>
            <span>1j <b>${fmtPct(r.u365)}</b></span>
            <span>sinds ${new Date(eerste).getFullYear()} <b>${fmtPct(r.uAll)}</b></span>
          </span>
        </div>
        <div class="uptime-balk" role="img" aria-label="Uptime laatste 90 dagen voor ${esc(r.h.naam)}">${r.blokken.join('')}</div>
        <div class="uptime-sub"><span>90 dagen geleden</span><span>${r.s.totaal} incidenten totaal · ${r.s.totaal * ctx.downtime} uur downtime</span><span>vandaag</span></div>
      </div>`
      )
      .join('');
  }

  /* ---------- Incidentenlog ---------- */
  function tekenIncidenten(ctx) {
    const sel = $('#filter-hotspot');
    sel.innerHTML += ctx.hotspots.map((h) => `<option value="${esc(h.id)}">${esc(h.naam)}</option>`).join('');
    const typeSel = $('#filter-type');
    const label = { incident: '💥 Klem', bijna: '😅 Bijna', nieuws: '📰 Nieuws' };

    const render = () => {
      const lijst = ctx.incidents
        .filter((i) => (!sel.value || i.hotspot === sel.value) && (!typeSel.value || i.type === typeSel.value))
        .slice()
        .reverse();
      $('#incidenten-body').innerHTML =
        lijst
          .map(
            (i) => `<tr class="${ctx.liveIds.has(i.id) ? 'live' : ''}">
          <td class="wanneer">${esc(datum(i.start))}</td>
          <td>${esc(ctx.byId[i.hotspot]?.naam)}</td>
          <td><span class="tag ${i.type}">${label[i.type]}</span>${esc(i.titel)}${i.type === 'incident' ? ` <small>(−${ctx.downtime}u)</small>` : ''}</td>
          <td class="postmortem postmortem-kolom">${esc(postmortem(i))}</td>
          <td>${i.bronnen.map((b) => `<a href="${esc(b.link)}" target="_blank" rel="noopener">${esc(b.medium)}</a>`).join('<br>')}</td>
        </tr>`
          )
          .join('') || '<tr><td colspan="5">Gain busjes gevonden. Verdacht rustig.</td></tr>';
    };
    sel.addEventListener('change', render);
    typeSel.addEventListener('change', render);
    render();
  }

  /* ---------- Persbericht ---------- */
  function tekenPers(ctx) {
    const { klem, hotspots, now, downtime } = ctx;
    const top = hotspots
      .filter((h) => h.id !== 'overig')
      .map((h) => ({ h, s: hotspotStats(h, ctx) }))
      .sort((a, b) => b.s.totaal - a.s.totaal)[0];
    const eersteJaar = klem.length ? new Date(klem[0].t0).getFullYear() : new Date(now).getFullYear();
    const jaar = new Date(now).getFullYear();
    const ditJaar = klem.filter((i) => new Date(i.t0).getFullYear() === jaar).length;
    const vorigJaar = klem.filter((i) => new Date(i.t0).getFullYear() === jaar - 1).length;
    const uTop = pct(downtimeIn(top.s.eigen, now - 365 * DAG, now), 365 * DAG);
    const media = new Set(klem.flatMap((i) => i.bronnen.map((b) => b.medium)));

    $('#pers-datum').textContent = datum(now, { day: 'numeric', month: 'long', year: 'numeric' });
    $('#pers-titel').textContent = `${top.h.naam} opnieuw Grunns gevaarlijkste busjesval`;
    const tekst = [
      `<b>GRONINGEN —</b> Sinds ${eersteJaar} zijn er in Stad en Ommeland minstens <b>${klem.length}</b> busjes, bestelwagens, campers, vrachtwagens en zelfs een Qliner klem komen te zitten onder viaducten, bruggen en tunneltjes. Dat blijkt uit een analyse van <b>zitereenbusjeklem.nl</b>, het eerste live busjesalarm van Nederland.`,
      `Koploper is het <b>${esc(top.h.naam)}</b> ("${esc(top.h.bijnaam)}") met <b>${top.s.totaal}</b> geregistreerde slachtoffers. De uptime van deze doorgang kwam het afgelopen jaar uit op <b>${fmtPct(uTop)}</b>.`,
      `In ${jaar} staat de teller op <b>${ditJaar}</b> busje${ditJaar === 1 ? '' : 's'}, tegen <b>${vorigJaar}</b> in heel ${jaar - 1}. Uitgaande van ${downtime} uur downtime per incident waren Groningse doorgangen in totaal <b>${nl(klem.length * downtime)} uur</b> geblokkeerd door een busje dat dacht dat het wel paste.`,
      `"Wij monitoren elke 15 minuten ${media.size} Groningse nieuwsbronnen," aldus de busjesradar. "Een busje klem onder een viaduct is in Grunn geen incident meer, het is folklore. Wij maken het meetbaar."`,
      `Alle data is open en vrij te gebruiken via zitereenbusjeklem.nl.`,
    ];
    $('#pers-tekst').innerHTML = tekst.map((p) => `<p>${p}</p>`).join('');
    $('#kopieer-pers').addEventListener('click', async (e) => {
      const plat = `${$('#pers-titel').textContent}\n\n${$('#pers-tekst').innerText}\n\nContact: pers@zitereenbusjeklem.nl`;
      try {
        await navigator.clipboard.writeText(plat);
        e.target.textContent = '✅ Gekopieerd!';
      } catch {
        e.target.textContent = '❌ Kopiëren mislukt, selecteer handmatig';
      }
    });
  }

  /* ---------- Bronnen ---------- */
  function tekenBronnen({ status }) {
    $('#bronnen-lijst').innerHTML = status.bronnen
      .map((b) => {
        const ok = b.status === 'ok';
        const uitleg = !ok && /sikkom/i.test(b.naam) ? ' (geblokkeerd, we lezen Sikkom via Google Nieuws)' : '';
        return `<li><span class="${ok ? 'bron-ok' : 'bron-fout'}">[${ok ? ' OK ' : 'FOUT'}]</span> ${esc(b.naam)} · ${b.items} items${esc(uitleg)}</li>`;
      })
      .join('');
  }

  /* ============ Geocities-extraatjes ============ */

  // busjes-cursorspoor
  let laatsteSpoor = 0;
  document.addEventListener('mousemove', (e) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = performance.now();
    if (t - laatsteSpoor < 70) return;
    laatsteSpoor = t;
    const s = document.createElement('span');
    s.className = 'spoor';
    s.textContent = Math.random() < 0.85 ? '🚐' : '💥';
    s.style.left = `${e.clientX + 8}px`;
    s.style.top = `${e.clientY + 8}px`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 800);
  });

  function busjesregen(n) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = 'regen';
      s.textContent = ['🚐', '🚚', '🚌', '💥', '🧱'][i % 5];
      s.style.left = `${Math.random() * 100}vw`;
      s.style.animationDuration = `${2 + Math.random() * 3}s`;
      s.style.animationDelay = `${Math.random() * 2}s`;
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 8000);
    }
  }

  // WebAudio: toeter en een zelfgecomponeerd MIDI-deuntje in de geest van 1998
  let audio;
  const ac = () => (audio ||= new (window.AudioContext || window.webkitAudioContext)());
  function toon(freq, t, duur, type = 'square', vol = 0.06) {
    const a = ac();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + duur + 0.02);
  }
  function toet() {
    const t = ac().currentTime;
    toon(392, t, 0.25, 'sawtooth', 0.12);
    toon(370, t + 0.28, 0.5, 'sawtooth', 0.12);
    busjesregen(8);
  }
  $('#toeter').addEventListener('click', toet);
  document.querySelector('.scene')?.addEventListener('click', toet);

  // Originele melodie: "Busje, Busje, Pas Op Je Kop"
  const MELODIE = [
    [523, 1], [659, 1], [784, 1], [659, 1], [698, 2], [587, 2],
    [523, 1], [587, 1], [659, 1], [523, 1], [392, 2], [0, 2],
    [440, 1], [523, 1], [698, 1], [659, 1], [587, 1], [523, 1], [587, 2],
    [659, 1], [587, 1], [523, 1], [494, 1], [523, 4],
  ];
  let muziekTimer = null;
  function speelMelodie() {
    const a = ac();
    const tel = 0.17;
    let t = a.currentTime + 0.05;
    for (const [f, d] of MELODIE) {
      if (f) {
        toon(f, t, d * tel * 0.9);
        toon(f / 4, t, d * tel * 0.9, 'triangle', 0.08);
      }
      t += d * tel;
    }
    return (t - a.currentTime) * 1000;
  }
  $('#muziek').addEventListener('click', (e) => {
    if (muziekTimer) {
      clearTimeout(muziekTimer);
      muziekTimer = null;
      e.target.textContent = '🎵 MIDI aan';
      return;
    }
    e.target.textContent = '🔇 MIDI uit';
    const loop = () => { muziekTimer = setTimeout(loop, speelMelodie()); };
    loop();
  });

  // Webring: draait je langs de hotspots
  let ring = 0;
  document.querySelectorAll('[data-ring]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const kaarten = document.querySelectorAll('.hotspot');
      if (!kaarten.length) return;
      ring = (ring + Number(a.dataset.ring) + kaarten.length) % kaarten.length;
      kaarten[ring].scrollIntoView({ behavior: 'smooth', block: 'center' });
      kaarten[ring].animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08) rotate(-2deg)' }, { transform: 'scale(1)' }], { duration: 600 });
    })
  );

  // Konami-code: ↑↑↓↓←→←→BA = BUSJESREGEN
  const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let k = 0;
  document.addEventListener('keydown', (e) => {
    k = e.key === KONAMI[k] ? k + 1 : e.key === KONAMI[0] ? 1 : 0;
    if (k === KONAMI.length) {
      k = 0;
      busjesregen(80);
    }
  });

  start();
  // Elke 5 minuten opnieuw kieken
  setInterval(async () => {
    try {
      const s = await laad('data/status.json');
      const was = document.body.classList.contains('alarm');
      if (s.klem !== was) location.reload();
    } catch { /* radar even kwijt */ }
  }, 5 * 60e3);
})();
