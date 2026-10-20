# The Claude routine

The site stores and shows flats. Finding new listings, logging landlord replies and, if you allow it, writing to landlords is done by a Claude Code scheduled task on your computer, in your own browser where you are logged in to Immowelt, Kleinanzeigen, WG-Gesucht and your email.

## What it does

- Runs your saved searches on Immowelt, Kleinanzeigen and WG-Gesucht and adds flats that fit your profile, with photos, commute times, red flags and a rating.
- Records rent and price changes and marks listings that disappeared.
- Logs landlord replies on the listing with what they are about: viewing invitation, documents request, rejection, question or other. A viewing invitation appears on the listing for you to confirm a time; a documents request waits for you to share documents.
- If you switch on "Contacting landlords" and approve templates: sends approved templates (first contact, viewing confirmation, documents follow, not interested anymore) at the pace you set.

## What it never does

- It never sends a template you have not approved, and never the same template twice to the same listing. Before every message it checks the listing, the portal inboxes and your email for a message that already does the same job for this flat (for a first contact: any earlier contact about it) and sends nothing if there is one. If it cannot tell, for example a housing company that has written to you about other flats, it does not send and lists the listing under "check manually".
- It never sends a viewing confirmation for a viewing you have not confirmed. Confirming or declining viewings is yours.
- It never sends, attaches or links documents, and cannot create share links: only you can, on the site. A documents request from a landlord is only recorded on the listing.
- It never edits templates, approvals, statuses, notes or viewing decisions: its key does not reach those routes.
- It never uses ImmoScout24: its terms forbid automated access. Add ImmoScout24 links by hand. The server refuses to send for any listing with an immobilienscout24.de link.
- It never answers a landlord in its own words.

## Install

1. Install Claude Code and the desktop app.
2. Set `SYNC_KEY` on your server (a long random value, for example `openssl rand -base64 32`). Save it in a file only you can read. The routine gets only this key, never the site password:

   ```bash
   mkdir -p ~/.flat-hunt && chmod 700 ~/.flat-hunt
   printf '%s' 'YOUR-SYNC-KEY' > ~/.flat-hunt/sync-key
   chmod 600 ~/.flat-hunt/sync-key
   ```

3. Create your searches yourself, logged in, on each portal (location, radius, rent or price, rooms, size), and save their result URLs, one per line:

   ```bash
   printf '%s\n' 'https://www.immowelt.de/…' 'https://www.kleinanzeigen.de/…' 'https://www.wg-gesucht.de/…' > ~/.flat-hunt/searches.txt
   ```

4. Copy `routine/SKILL.md` to `~/.claude/scheduled-tasks/flat-hunt-listing-check/SKILL.md` and replace `https://YOUR-SITE.up.railway.app` with your site's address.
5. Keep each saved search to three result pages or fewer (narrow the filters). The routine reads at most three pages per search; if a search has more, it cannot tell which listings disappeared and never marks any as gone.
6. In the Claude desktop app, create a scheduled task from it, for example every 3 hours during the day.
7. The routine only runs while the computer is awake, and its browser must be logged in to the portals and your email and connected to Claude. Pausing in the page header only stops sending; to stop the routine completely, disable the scheduled task in the Claude desktop app.

## Sending messages

Nothing is sent until you:

1. tick "Let the Claude routine contact shortlisted landlords in my name" in Settings → Contacting landlords, and set the message language, the minimum minutes between two messages and the messages per day at most;
2. approve each template you want used (Settings → Contacting landlords → Message templates). Editing a template withdraws its approval; approve the new version again.

The pause switch in the page header ("Sending on" / "Sending paused") stops new sends: the server refuses every new send slot while it is paused, and the routine checks the switch right before every send. A message that is already being sent when you pause can still go out. The header also shows how many messages went out today against your daily limit.

A send slot (claim) that the routine does not report on within 24 hours expires and then blocks that message for that listing for good, because a send may have happened. You see it in the update log as "Expired, maybe sent: check" and can contact the landlord yourself. If the routine cannot record or confirm a sent message, it tells you in its report ("check manually") and does not send it again.

The routine first contacts only shortlisted listings that meet all your criteria. Every outgoing message appears on the listing with its template and version.

## Portal terms

Immowelt, Kleinanzeigen and WG-Gesucht are used in your own logged-in browser, at a human pace, for your own flat search. Check each portal's terms yourself; if a portal objects to automated use, remove its search from `searches.txt`. ImmoScout24 is manual only.
