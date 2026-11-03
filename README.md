# zitereenbusjeklem.nl 🚐💥

Het live busjesalarm van Grunn. Zit er nou n busje klem onder een viaduct in Stad?

## Wat zit erin

| Pad | Wat |
|---|---|
| `index.html`, `css/`, `js/` | De site (statisch, geen build) |
| `badge.html` | Insluitbare live-badge voor andere sites |
| `scraper/scrape.mjs` | De busjesradar (Node 26+, geen dependencies) |
| `data/hotspots.json` | De doorgangen, met coördinaten en zoekpatroon. **Hier pas je hotspots aan.** |
| `data/incidents.json` | Alle incidenten (wordt door de scraper bijgewerkt, handmatige correcties blijven staan) |
| `data/status.json` | Is er *nu* een busje klem? |
| `feed.xml` | RSS-feed van incidenten |

## Hoe het werkt

1. De scraper leest RTV Noord en OOG direct, en Sikkom + DvhN via Google Nieuws-zoekopdrachten
   (Sikkom blokkeert directe bots met een 403).
2. Koppen worden gefilterd op *klem/vast/ramt* + *viaduct/brug/tunnel/balk* + *busje/bestelwagen/camper/...*
   en alleen Groningse media tellen mee.
3. Meldingen worden aan een hotspot gekoppeld via `match` in `hotspots.json`; meldingen van hetzelfde
   punt binnen 36 uur worden één incident.
4. Elk incident = 4 uur downtime. Een incident is "live" als het minder dan 4 uur oud is.
5. Koppen met *net op tijd/net niet* worden een **bijna-busje** (geen downtime), beleidsnieuws
   (hoogteportalen, "feest") wordt **nieuws**.

## Lokaal draaien

```bash
npm run scrape
```

```bash
npm run dev
```

Open daarna http://localhost:8080.

## Live zetten (GitHub Pages)

1. Push deze map naar een GitHub-repo (branch `main`).
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. De workflow `.github/workflows/busjesradar.yml` scant elke 15 minuten, commit nieuwe busjes en deployt.
4. DNS bij je registrar voor `zitereenbusjeklem.nl`: A-records naar `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153` (en `www` als CNAME naar `<gebruiker>.github.io`).
   Vul het domein ook in bij Settings → Pages → Custom domain en zet HTTPS aan.

Let op: GitHub draait cron-jobs "best effort", soms een paar minuten later. En nieuwsmedia
melden een busje meestal pas als het er al even zit, dus "live" betekent "zo live als de pers".

## Mailadressen

De site verwijst naar `pers@`, `tips@` en `gastenboek@zitereenbusjeklem.nl`. Zet daar forwarding voor
op bij je domeinregistrar, anders komen tips nergens aan.
