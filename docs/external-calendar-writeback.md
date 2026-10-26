# Family calendar: phones today, Google/iCloud write-back later

## What works now (no setup)

- **Family calendar on the wall.** Tap **+ Event** on the Calendar (wall or phone, parent PIN). Events can be timed or all-day, can span several days, can repeat weekly, monthly or yearly, and can belong to one person or the whole family. They're stored in the app's own D1 database. They show in every calendar view, take the person's colour, and follow the person filter. Family-wide events show under every person.
- **Read-only copy on phones.** Settings → *Family calendar on phones* → **Create phone link**. Then subscribe to that private `https://…/feed/<token>.ics` link:
  - Google Calendar (web): Other calendars → **+** → *From URL*. Google refreshes subscribed calendars on its own schedule, often every few hours or more.
  - iPhone: Settings → Calendar → Accounts → Add Account → Other → *Add Subscribed Calendar*.
  - Anyone with the link can read these events. Use **New link** to revoke an old one, or **Turn off**.

Edits made on phones don't flow back with this; events are created and changed on the wall or in the app on a phone.

## Optional: write events into a real Google or iCloud calendar

This needs credentials only David can create. The Settings card shows **Setup needed** until they're stored as Worker secrets. Nothing is pushed yet: the push code is the next step once the credentials exist, so it can be tested against the real account.

### Option A: Google Calendar (OAuth)

1. Go to https://console.cloud.google.com/ and create a project (free), e.g. "Wall calendar".
2. Under APIs & Services → Library, enable the **Google Calendar API**.
3. Set up the OAuth consent screen:
   - Type **External**. Add yourself as a **Test user**.
   - Scope: `https://www.googleapis.com/auth/calendar.events`.
   - Note: in "Testing" mode the refresh token expires after 7 days. Publishing the app to "In production" without verification is fine for personal use; Google shows an "unverified app" screen you click through once.
4. Under Credentials → Create credentials → **OAuth client ID**:
   - Type: Web application.
   - Authorized redirect URI: `https://wall-calendar.therealdavidlarsen.workers.dev/api/google/callback`.
5. Store the secrets on the Worker. Never paste them into chat or commit them.
   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   The one-time "Connect Google" button gets the refresh token. It is stored as `GOOGLE_REFRESH_TOKEN` (or in D1, encrypted with a Worker secret).
6. Pick the target calendar, e.g. a new Google calendar called "Family". Its Calendar ID is under Settings → *Integrate calendar*.

### Option B: iCloud (CalDAV + app-specific password)

1. At https://account.apple.com → Sign-In and Security → **App-Specific Passwords**, create one named "Wall calendar". Two-factor authentication must be on.
2. In the Calendar app, create a calendar to write into, e.g. "Family (wall)".
3. Store the secrets:
   ```sh
   npx wrangler secret put ICLOUD_APPLE_ID        # the Apple ID email
   npx wrangler secret put ICLOUD_APP_PASSWORD    # xxxx-xxxx-xxxx-xxxx
   ```
   The Worker finds the calendar via CalDAV discovery (`https://caldav.icloud.com/`, then the principal, then the calendar home), and `PUT`s one `.ics` per event using the same UID as the feed (`fe-<id>@wall-calendar`). Edits overwrite it and deletes remove it.

### Tradeoffs

| | Phone link (now) | Google OAuth | iCloud CalDAV |
|---|---|---|---|
| Setup | none | ~15 min in Google Cloud console | ~3 min |
| Update delay on phone | hours (Google), ~15 min–1 h (iPhone) | seconds | seconds |
| Edits on phone flow back | no | no (one-way push) | no (one-way push) |
| Secret stored | none | client secret + refresh token | app-specific password (full calendar/contacts access) |
| Cost | free | free | free |

The free Cloudflare tier covers all of these.
