# Flat Hunt: design

Date: 19.10.2026. Status: approved in chat.

## Goal

A self-hosted tracker for finding a flat to rent or buy in Germany. Each person runs their own copy. They describe themselves (household, job, income), what they want (rent and/or buy, size, rooms, move-in date) and where (commute limits to important places plus an optional radius). The site ranks listings by their own weights, analyses each listing's surroundings with sourced facts, keeps landlord conversations, stores application documents encrypted and shares them only after the owner approves. An optional Claude Code routine finds listings and sends approved template answers.

Flat Hunt starts as a copy of Car Hunt (https://github.com/DasMehl/car-hunt) with fresh history: same server pattern, storage, password, wizard and Settings framework, add/edit/delete, map, weighted scores, en/de/pt, routine structure.

Out of scope: accounts or several hunts in one copy; server-side scraping of portals; automated access to ImmoScout24 (its terms forbid it — its links can still be added by hand); a per-street "danger score"; sending documents without the owner's approval.

## Decisions made in chat

- Renting and buying, selectable per copy (one or both).
- Documents leave only after the owner approves, through an expiring, watermarked link.
- Search area = up to five important places with a maximum travel time (car, public transport or bike) plus an optional radius; a listing must satisfy all limits.
- Public repository; no personal data in code.
- Built in four phases, each usable on its own.

## Phases

1. **Core tracker** — profile (rent/buy, flat, places, radius, red flags, weights, income), listings with add/edit/delete, criteria check, scores, commute times, affordability, costs panel, map. Usable by hand.
2. **Applicant profile and document vault** — applicant details and summary, encrypted documents, approval-gated share links with watermark and access log, redaction helper.
3. **Area analysis** — sourced facts per listing. Starts with a spike that confirms each data source's availability and licence; a source that fails is dropped, never faked.
4. **Routine and automatic answers** — Claude Code routine for Immowelt, Kleinanzeigen and WG-Gesucht; approved templates; reply handling; pause switch.

Each phase gets its own implementation plan.

## Profile (`DATA_DIR/profile.json`, phase 1)

```json
{
  "version": 1,
  "name": "Flat Hunt",
  "languages": ["en", "de", "pt"],
  "modes": { "rent": true, "buy": false },
  "money": { "netIncome": 3200, "affordShare": 0.33 },
  "rent": { "maxWarm": 1200, "maxCold": null, "maxDeposit": null, "maxTakeover": null },
  "buy": { "maxPrice": 350000, "equity": 70000, "apr": 3.8, "years": 25, "state": "NW", "agentFeePct": 3.57 },
  "flat": {
    "roomsMin": 2, "roomsMax": null, "sizeMin": 55, "sizeMax": null,
    "floorMin": null, "floorMax": null, "needsLift": false,
    "outdoor": "any", "kitchen": "any", "pets": false,
    "moveInFrom": null, "moveInTo": null, "wbs": "none"
  },
  "places": [ { "label": "Work", "address": "Königsallee 1, 40212 Düsseldorf", "lat": 51.2254, "lon": 6.7787, "mode": "transit", "maxMin": 40, "time": "08:00" } ],
  "radius": { "center": null, "km": null },
  "redFlags": [ { "id": "deposit-before-viewing", "on": true } ],
  "weights": { "price": 2, "size": 1.5, "commute": 2, "area": 1, "condition": 1, "contact": 1 },
  "outreach": { "enabled": false, "paused": false, "language": "de" }
}
```

- `modes`: at least one true. Rent-only fields are ignored when `rent` is false, likewise for `buy`.
- `money.netIncome`: household net per month; `affordShare` (0.2–0.5, default 0.33) is the share of income housing may take.
- `buy.state`: two-letter German state code; it selects the land-transfer-tax rate.
- `flat.outdoor`: any | balcony | garden; `kitchen`: any | required; `wbs`: none (no housing permit) | have (permit held, WBS flats allowed) | exclude (hide WBS-only flats).
- `places`: 0–5 entries; `mode`: car | transit | bike; `maxMin` 5–180; `time` HH:MM used for transit planning on a weekday.
- `radius`: optional; both `center` and `km` set, or both null.
- Validation is strict like Car Hunt's (unknown keys rejected, ranges, enums, cross-field rules).

## Listing record (`DATA_DIR/listings.json`)

Listing fields: `title`, `url`, `source` (immowelt | kleinanzeigen | wg-gesucht | immoscout | other | manual), `mode` (rent | buy), `coldRent`, `utilities`, `warmRent`, `deposit`, `takeover`, `price`, `rooms`, `size`, `floor`, `lift`, `outdoor`, `kitchen`, `petsAllowed`, `availableFrom`, `wbsRequired`, `address`, `postcode`, `city`, `district`, `lat`, `lon`, `commute` (array aligned with `profile.places`: `{minutes, checkedAt}` or null), `area` (phase 3 cache), `contact` (`{name, type: private | agent | company}`), `photos`, `rating` (`price, size, commute, area, condition, contact`, 0–10), `redFlags` (ids found), `verdict`, `pros`, `cons`, `questions`, `i18n`, `addedAt`, `lastSeenAt`, `priceHistory`.

Owner fields (edited on the page): `status` (new | contacted | viewing-invited | viewing-done | applied | docs-requested | accepted | rejected | dropped | gone), `nextStep`, `notes`, `pick`, `messages`, `docRequests` (phase 2).

- `warmRent` is computed as `coldRent + utilities` when not given.
- Manual add and edit work as in Car Hunt; a changed address recomputes coordinates and commute times; deleting removes photos and log entries.

## Criteria, scores and affordability (phase 1)

- Criteria check (shared browser/Node module like Car Hunt's `criteria.js`): mode enabled, warm/cold rent or price limits, deposit and takeover limits, rooms, size, floor, lift, outdoor, kitchen, pets, move-in window, WBS rule, every place's commute limit (unknown commute passes but is marked), radius, red flags. Failing listings are labelled with reasons and sorted below, never deleted.
- Score = round(Σ rating × weight ÷ Σ weights × 10). Listings without `rating` get an estimate from data (price vs limit, size vs minimum, commute vs limits, equipment) shown with "≈", as in Car Hunt.
- Affordability:
  - Rent: `warmRent ÷ netIncome` → fits (≤ affordShare), tight (≤ affordShare + 0.05), too much.
  - Buy: monthly annuity on `price + purchase costs − equity` at `apr` over `years`, compared the same way. Purchase costs = land-transfer tax for `state` + 2 % notary and land registry + `agentFeePct`. The state rates live in one table in the code with the date they were checked; the page says "rates as of <date>, check before buying".
- Costs panel: per listing, monthly (warm rent or loan payment + an editable maintenance reserve for buying) and one-off (deposit and takeover, or purchase costs + equity used).

## Commute (phase 1)

- Car: OSRM driving (`router.project-osrm.org`). Bike: the FOSSGIS bike router (`routing.openstreetmap.de/routed-bike`). Public transport: Transitous, next weekday at the place's `time`, arriving by then.
- Computed on the server when a listing is added or its address changes, and by the routine; each value stores `checkedAt`. A failed lookup leaves the value null.

## Red flags (phase 1)

Built-in catalogue (`public/redflags.json`, en/de/pt label and reason, a text pattern for the routine and the manual add's notes): deposit or fees before a viewing; owner abroad / keys by post; price far below tracked listings in the same city (computed, not text); payment by gift card, crypto or money-transfer service; request for ID copy before any contact; "Besichtigung nur gegen Gebühr". Users toggle entries and add their own patterns.

## Applicant profile and vault (phase 2)

- `applicant.json`: name, email, phone, household (adults, children, pets), job (title, employer, since, permanent), credit report available, current landlord reference available, short "about us". Stored encrypted.
- Applicant summary: generated one page (HTML → PDF on demand) in de/en/pt from `applicant.json` and `money.netIncome`.
- Vault: uploads (PDF, JPEG, PNG; ≤ 10 MB each) stored in `DATA_DIR/vault/` encrypted with AES-256-GCM using `VAULT_KEY` (32 bytes, base64, environment variable, never on the volume). Metadata (type: payslip | contract | schufa | id | rent-confirmation | landlord-reference | other, label, document date, size) is encrypted too. The server refuses to start with vault data but no or a wrong `VAULT_KEY`. Payslips older than three months are flagged.
- Sharing: a document request on a listing shows a checklist; on approval the server creates a share: random 32-byte token (only its SHA-256 stored), listing id, document ids, expiry (default 7 days, 1–30), revocable. `GET /s/<token>` is public (the only public route besides `/healthz`), rate-limited, `Cache-Control: no-store`, `X-Robots-Tag: noindex`, and serves each document as a PDF with a watermark on every page: "Only for the application for <listing address>, <date>". Each opening is logged with time (no IP).
- Redaction helper: in the browser, render a page (pdf.js from cdnjs for PDFs), draw black boxes, save as a flattened image PDF so the covered text is gone. Before the first share of a payslip the site reminds the owner to cover tax ID, social-security number and bank details.

## Area analysis (phase 3)

Panel per listing, each figure with source, area level and date:
- Everyday life from OpenStreetMap (Overpass): nearest transit stop and lines, supermarket, pharmacy, doctor, kindergarten, school, park, playground — walking minutes.
- Noise: whether the point lies in a mapped noise zone (main roads, rail, airports) from the official German noise mapping.
- Flood: whether the point lies in a mapped flood-hazard area from the federal flood maps.
- Crime: police crime statistics per district/city (crimes per 100,000 people vs national average); finer city-district data where a city publishes it (e.g. Berlin). Always labelled area-level.
- Price check: price per m² vs the tracked listings in the same postcode/city.
Results are cached per listing (`area`, with `computedAt`); recomputed on demand.

## Routine and automatic answers (phase 4)

- `routine/SKILL.md` template like Car Hunt's: reads the profile, searches Immowelt, Kleinanzeigen and WG-Gesucht in the owner's browser, applies the criteria, adds listings with photos and commute times.
- Templates (first contact, viewing confirmation, documents follow) edited and approved in Settings, in de/en, filled from the applicant summary.
- Sends only when `outreach.enabled` and not `paused`; human pace (minimum minutes between messages, daily cap set in Settings); once per listing; duplicate check across tracker, portal inboxes and email before every send, never re-send.
- Replies: viewing invitation → owner confirms the time on the site; document request → status `docs-requested` and the approval step; refusal → `rejected`.

## Security

- `SITE_PASSWORD` required (refuse to start without, unless `ALLOW_OPEN=1`), as in Car Hunt.
- `VAULT_KEY` required once the vault holds data.
- Public routes: `/healthz`, `/s/<token>` only.
- No personal data in the repository; checks grep a private pattern list before every push.

## Testing

- Server tests per phase (node:test, in-process `createApp`): profile validation, listing add/edit/delete with stubbed geo/commute calls, criteria and score units, affordability and purchase-cost maths, vault encrypt/decrypt round trip and wrong-key refusal, share creation/expiry/revocation/rate limit/watermark presence, red-flag matching.
- Browser check per phase: wizard on an empty data dir, add/edit/delete, desktop and phone, de/pt.
