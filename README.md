# Family wall calendar

A do-it-yourself family wall display, similar to a Skylight Cal Max: a shared calendar, chores and habits with stars, rewards, photos and the weather. It's built for a 27" 1080p touchscreen in landscape and also works on phones.

It runs on **one Cloudflare Worker** with a **D1** database, all on the free tier. There's no build-time framework and no paid service.

## What it does

- **Calendar:** month, week, day and list views. Each calendar has its own color and can be toggled on the legend. Sources are ICS/webcal links, such as an iCloud public calendar or a Google "secret address in iCal format". The Worker refetches them every 10 minutes (cron) and expands recurring events (RRULE, EXDATE, RDATE, moved instances) in the family time zone (default `America/Chicago`). The top bar shows when calendars last synced.
- **Family calendar:** tap **+ Event** (parent PIN) on the wall or a phone to add a timed or all-day event. Events can repeat weekly, monthly or yearly and can belong to one person or the whole family. They're stored in D1, merged into every view, and can be shared to phones as a private read-only `.ics` link (Settings). The **Everyone / person** chips filter the calendar to one person's calendars and events. Write-back into Google or iCloud: see [docs/external-calendar-writeback.md](docs/external-calendar-writeback.md).
- **Countdowns:** on Home, e.g. "Disney trip in 55 days". Birthdays and holidays can repeat every year.
- **Lists and meals:** shared grocery and to-do lists; no PIN needed to add or tick items. A weekly meal plan can send its ingredients to the grocery list.
- **Routines and kid pages:** step-by-step morning and bedtime routines that kids tick through, and a page per kid with their routines, chores, rewards and stars.
- **Family:** add, edit and remove people (name, color, emoji avatar, kid or parent) in Settings. No names are hardcoded.
- **Chores, habits and activities:** each one has an icon, a star value, the kids it's assigned to, a time of day and a repeat (every day, school days, chosen weekdays, or once). Kids tap to finish one, get a celebration and earn stars. Tapping again undoes it. With **Parent approval** on, taps wait until a parent approves them.
- **Stars and history:** every star is a ledger entry: earned, redeemed, or a parent adjustment with a note.
- **Rewards:** fully custom (name, details, icon, star cost).
  - *Per kid:* uses that kid's stars. It can be limited to stars from chosen chores or habits, e.g. "Good bedtime × 5 = ice cream".
  - *Family goal:* everyone's stars add up toward one goal. Redeeming it resets the goal and leaves personal balances alone.
  - Redeeming always needs the parent PIN and is logged.
- **Photos:** uploaded from any phone or computer behind the PIN, resized in the browser (1920 px max) and stored in D1. They show as an idle slideshow and on the Photos page. Photos can be sorted into albums, and the slideshow can be limited to chosen albums.
- **Weather:** pick a city in Settings (Open-Meteo, no API key). Shows the current temperature, high/low and a 5-day forecast in °F or °C.
- **Always-on screen care:** auto light/dark, night dimming between set hours (a tap wakes it for 2 minutes), a small pixel drift every 3 minutes, and an idle photo slideshow. The app reloads itself at 3:10am. If the internet drops, it keeps showing the last data it got, with an "Offline" banner.

## Privacy and the parent PIN

- On first visit you choose a parent PIN (4–8 digits). It's stored as a salted PBKDF2 hash and is never in the code.
- **Viewing needs a connected device.** Each screen or phone enters the PIN once, then stays connected for 400 days. Without that, the URL shows nothing but a PIN pad.
- **Parent mode** (settings, rewards, photos, star changes) times out after 15 idle minutes. Phones can choose "keep parent mode for 30 days".
- Kids can tick off chores without the PIN.
- Wrong PINs are rate-limited. Settings → Security → "Disconnect others" signs out every other device.
- Calendar links are private: anyone with the link can read that calendar. They're only sent to the browser in parent mode.

## Getting calendar links

- **iCloud (iPhone):** Calendar app → Calendars → ⓘ next to the calendar → turn on **Public Calendar** → Share Link → Copy. Or on icloud.com/calendar, use the share icon → Public Calendar. It starts with `webcal://`, which is fine to paste.
- **Google:** on a computer, open calendar.google.com → Settings → pick the calendar → **Integrate calendar** → copy **Secret address in iCal format**.

Changes show up within about 10–20 minutes. Google and iCloud cache their feeds, and the Worker checks every 10 minutes. Settings → Calendars → **Sync now** forces a check.

## Develop

```bash
npm install
npm test                     # ICS/recurrence and star-ledger tests (node --test)
npm run build                # inlines public/ into the Worker -> dist/worker.js
node scripts/migrate-local.mjs   # fresh local DB: schema.sql + migrations/*.sql
npx wrangler dev --local     # http://localhost:8787
node scripts/e2e.mjs http://localhost:8787 /tmp/wc --seed   # Playwright smoke test + screenshots (fresh DB)
node scripts/e2e-features.mjs http://localhost:8787 /tmp/wcf --steps 1,2,3,4   # lists/meals, routines, countdowns/albums, family calendar
```

Code map: `src/worker.js` (API, auth, sync), `src/ics.js` (ICS parser and RRULE expander), `src/tz.js` (time zones), `src/logic.js` (chores, stars and rewards, shared with the browser), `public/` (the app).

## Deploy (Cloudflare free tier)

With Wrangler:

```bash
npx wrangler login
npx wrangler d1 create wall-calendar        # put the id in wrangler.toml
npx wrangler d1 execute wall-calendar --remote --file=schema.sql
for f in migrations/*.sql; do npx wrangler d1 execute wall-calendar --remote --file=$f; done   # new installs; upgrades: node scripts/mk-deploy.mjs migrate (tracks applied ones)
npm run build && npx wrangler deploy        # also sets the */10 cron
```

Without Wrangler, `scripts/mk-deploy.mjs` writes the same steps (create DB, schema, upload, cron) as Cloudflare API scripts.

Free-tier notes: Workers allow 100k requests/day, and the screen uses roughly 2–3k. D1 gives 5 GB storage, so a few hundred photos fit easily (the app caps at 400). CPU is limited to 10 ms per request, so very large calendars are cached and only re-expanded when they change.

## Raspberry Pi kiosk

Tested only in desktop Chromium, not on a Pi yet.

1. Install Raspberry Pi OS (Desktop, 64-bit) and connect the touchscreen.
2. `sudo apt install -y chromium-browser fonts-noto-color-emoji unclutter`
3. Turn off screen blanking: `sudo raspi-config` → Display Options → Screen Blanking → **No**.
4. Open Chromium once normally, go to your URL and enter the PIN to connect the screen.
5. Autostart in kiosk mode. On Wayland (Bookworm), add to `~/.config/labwc/autostart` (or the `wayfire.ini` `[autostart]` section):
   ```
   chromium-browser --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --check-for-update-interval=31536000 https://YOUR-URL/
   ```
6. On-screen keyboard: for typing in Settings on the wall, install `squeekboard` (Wayland) or use a phone for Settings. Every setting is also available on a phone.

## Limits and next ideas

- Linked Google and iCloud calendars are read-only. Events added on the wall go into the local family calendar, not into Google or iCloud, until write-back is set up (see docs/external-calendar-writeback.md).
- No Google sign-in (OAuth). It uses the secret iCal link instead.
- Weather is fetched by each screen directly from Open-Meteo.
