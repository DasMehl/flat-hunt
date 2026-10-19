# Flat Hunt

A private tracker for finding a flat to rent or buy, run by each person on their own server. You describe your household and income, what you want and where you need to get to every day. The site ranks listings by your priorities, checks commute times and keeps your conversations with landlords. Planned for later phases: area analysis with sourced facts, and encrypted storage for your application documents, shared only after you approve, through an expiring, watermarked link.

A Claude Code routine that finds new listings and sends replies from templates you approve is planned (phase 4).

## Status

Phase 1 (core tracker) is built. Phases 2 to 4 are planned. The full design is in [docs/design.md](docs/design.md). It builds on [Car Hunt](https://github.com/DasMehl/car-hunt).

## What it does in phase 1

- **Profile:** rent, buy or both; flat requirements; up to five important places with a travel-time limit each (car, bike or public transport); an optional radius; red-flag toggles; weights for the score; monthly net income.
- **Listings:** add and edit by hand, delete. An address change recomputes coordinates and commute times.
- **Commute:** car minutes via OSRM, bike minutes via the FOSSGIS bike router, public transport via Transitous, planned for the next weekday at each place's time.
- **Criteria check:** every listing is checked against the profile. Failing listings stay in the list, labelled with the reasons, and sort below the rest. Unknown commute times pass but are marked.
- **Red flags:** a built-in catalogue (deposit before a viewing, payment by gift card, ID copy before any contact, and similar). You can switch entries off and add your own patterns.
- **Scores:** a weighted score per listing. Listings get an estimated score from their data, shown with "≈"; the routine (phase 4) adds full ratings.
- **Affordability:** rent divided by net income, or the loan payment for a purchase, compared with the share of income you set aside for housing.
- **Purchase costs:** land-transfer tax by German state, plus 2 % for notary and land registry, plus the agent fee you enter. The rates were checked in June 2026; check again before buying.
- **Costs panel:** monthly and one-off costs per listing, including an editable maintenance reserve for purchases.

## Run your own copy

You need Node.js 18 or newer and a Railway account (or any host that runs a Node server with a persistent disk).

1. Fork this repository on GitHub.
2. In Railway, create a project from your fork. Railway reads `railway.json` for the build and start command (`npm start`) and the health check (`/healthz`).
3. Add a volume to the service, mounted at `/data`.
4. Set these variables on the service:
   - `DATA_DIR=/data` — where the JSON data files are kept. Without the volume, data is lost on redeploy.
   - `SITE_PASSWORD` — the password for the whole site. The server refuses to start without it.
   - `SYNC_KEY` — a secret for the routine's API calls and photo uploads. Without it those routes return 503. You can leave it unset if you do not use the routine.
5. Deploy, then open the Railway URL and sign in with `SITE_PASSWORD`. The setup wizard asks for your profile on first use.

`/healthz` is the only route that does not require the password.

To run locally without a password (for trying it out only):

```sh
ALLOW_OPEN=1 DATA_DIR=./data SYNC_KEY=dev npm start
```

Then open http://localhost:3000. With `ALLOW_OPEN=1`, anyone who can reach the server can see and edit the hunt.

Set `SEED=1` on the first start, with no `listings.json` yet, to load example listings from a `seed.json` next to `server.js`. No seed file ships with the repository; without one the hunt starts empty.

To run the tests:

```sh
npm test
```

## Coming next

- **Phase 2: applicant profile and document vault.** Applicant details and a one-page summary, encrypted document storage (`VAULT_KEY`), and approval-gated share links with a watermark and an access log.
- **Phase 3: area analysis.** Sourced facts per listing: everyday amenities, noise and flood zones, police crime statistics at district level, and price per m² against your tracked listings.
- **Phase 4: routine and automatic answers.** A Claude Code routine that searches Immowelt, Kleinanzeigen and WG-Gesucht in your own browser, and sends approved template replies at a human pace, never twice to the same listing.

## Data and services

Flat Hunt uses free public services and does not run its own scrapers:

- [OpenStreetMap](https://www.openstreetmap.org/copyright) map data, and [Nominatim](https://nominatim.org/) for geocoding addresses.
- [OSRM](https://project-osrm.org/) for driving times.
- [FOSSGIS](https://routing.openstreetmap.de/) bike routing for cycling times.
- [Transitous](https://transitous.org/) for public-transport times.

The lookups run on your server when you add or edit a listing, and from the routine. Each service has a usage policy; keep your use within it.
