# USA Security Connect

Workforce operations platform for **USA Security & Protection Group** — guard tour, time
and attendance, incident reporting, supervision and billing, in one system:

- a **web app** for officers *and* the admin console,
- a **mobile app** built from one codebase for **Android and iPhone**, and
- a **client portal** where a site contact sees the service they are paying for.

All three talk to the same API, and the rules that decide "late", "missed check-in" or
"outside the geofence" live in one shared module so no surface can disagree with
another. One thing gets captured once: an officer's clock-in is the same record that
produces their timesheet, the client's coverage report and the invoice line.

---

## Quick start

```bash
npm install
npm run seed      # demo sites, posts, officers, shifts, incidents, tours
npm run dev       # API on :4000, web app on :5173
```

Open <http://localhost:5173> and sign in with a demo code + PIN:

| Code | PIN | Who | Notes |
|------|-----|-----|-------|
| `1001` | `2468` | Vince Ortega | Administrator — W-2 salaried, exempt |
| `1002` | `3571` | Renata Diaz | Field supervisor — W-2 hourly |
| `1003` | `4812` | Marcus Bell | Officer, **currently on post** |
| `1004` | `5930` | Janelle Carter | Officer — licence expiring soon |
| `1005` | `6174` | Dwayne Foster | **1099 contractor**, armed post |
| `1006` | `7285` | Alicia Nunez | Officer — W-2 hourly |
| `1007` | `8140` | Kevin Osei | New hire — forced to change PIN at first sign-in |
| `1008` | `9351` | Renee Okafor | **1099 contractor**, paid per shift |

> These fixed PINs exist only in the demo seed. Real accounts get a random PIN
> generated in the admin console and shown exactly once.

The client portal is at <http://localhost:5173/portal>, with its own sign-in:

| Email | Password | Property |
|-------|----------|----------|
| `dana.whitfield@riverfrontholdings.com` | `riverfront-portal-01` | Riverfront Commerce Center |
| `marcus.reyes@palmettoridgehoa.org` | `palmetto-portal-02` | Palmetto Ridge Residences |
| `alicia.grant@gulfportfreight.com` | `gulfport-portal-03` | Gulfport Logistics Yard |

Sign in as two different contacts to see the scoping: neither can reach the other's
property, and neither sees a pay rate.

### Mobile

```bash
npm run mobile            # Expo dev server; press a for Android, i for iOS
npm run mobile:check      # bundles the app without a device, to catch errors
```

The Android emulator reaches your machine on `10.0.2.2`, which is the default in
`apps/mobile/app.json`. On a physical phone, set your machine's LAN address:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.50:4000/api npm run mobile
```

---

## What it does

### Officer (web + mobile)

- **Clock in / out** behind a deliberate slide gesture, with GPS verification against
  the post's geofence. Too far away and the officer must give a reason, which is
  attached to the record and raised with a supervisor.
- **Status check-ins** on a per-post cadence. Miss the window and it is flagged
  automatically; the next prompt is still queued so the cadence continues.
- **Incident reports** — category, severity, what happened, how it was resolved,
  people involved and notified, police report number, cost recovery, and photos
  (camera or library on mobile).
- **Tours and tasks** — walk a route, scan each checkpoint by NFC/QR tag or manually,
  tick off per-checkpoint tasks, or skip with a recorded reason. Required checkpoints
  block completion until they are dealt with.
- **Schedule** — upcoming and worked shifts, hours, overtime, and anything flagged.
- **Broadcasts and training** — priority notices with read/acknowledge receipts, and
  required videos that cannot be marked complete until they have actually been watched.
- **Messaging** with supervisors and dispatch.
- **Supervisor visits** (supervisors only) — uniform, post orders, equipment and site
  checks, logged with GPS.
- **Duress button** — one tap plus a confirmation alerts every supervisor with the
  officer's name, post and position. It fires immediately rather than waiting on GPS,
  repeat presses update the same alert instead of flooding the board, and the officer
  is told the moment a supervisor acknowledges.
- **Meal and rest breaks** — meal time is unpaid and deducted from the shift; rest
  breaks stay paid.
- **Time-off requests** — pick dates and a reason; overlapping requests are refused,
  and the decision comes back as a notification.
- **Push notifications** for urgent broadcasts, check-ins that fall due, and messages.

### Admin console (web)

- **Live dashboard** — who is on post right now, minutes on post, missed check-ins,
  officers outside their geofence, unfilled shifts.
- **Safety &amp; live map** — open duress alerts with one-tap call and directions, plus a
  map of every post, its geofence, and where each officer actually clocked in.
  Refreshes every 15 seconds.
- **Employee profiles** — contact details, mailing address, emergency contact and
  relationship, uniform size, hire date, home site, internal notes, and
  **PIN generation/reset shown once**.
- **Employment classification** — W-2 or 1099 per person, with the paperwork that goes
  with it. A 1099 cannot be made active without a W-9 on file, and "exempt" is refused
  on a contractor. Contractor records carry business name, tax ID last four, signed
  agreement and certificate-of-insurance expiry.
- **Pay &amp; billing** — hourly, salary or per-shift; pay rate, client bill rate, and
  overtime multiplier. A live preview shows a worked example before you save.
- **Schedule** — week grid, conflict detection, and a recurring roster builder that
  handles overnight shifts.
- **Shift requests** — open shifts officers can claim, swaps they can offer each other,
  and drop requests, all landing in one supervisor queue. Eligibility is checked at
  every step, so an officer without a current Class G licence cannot end up on an armed
  post; approving a claim automatically declines the officers who lost out.
- **Invoices** — raised from hours already on the clock at the bill rate that applied,
  one line per post. Preview before committing, tax and payment terms per invoice,
  CSV export, and a receivables view with margin and an overdue count. A period that
  overlaps an existing invoice is flagged before the same hours get billed twice.
- **Client portal logins** — create a read-only account for a site contact, choose which
  properties it can see, reset the password or suspend it.
- **Timesheets** — hours by officer with the regular/overtime split **driven by
  classification**, unpaid break deductions, exception badges, estimated pay, client
  billing and margin, every individual punch, and **CSV export for payroll**.
- **Time off** — approve or deny with a note; approving reports how many rostered
  shifts still need re-covering.
- **Licensing &amp; certifications** — one board for state licences, certifications and
  contractor insurance, showing what has expired and what lapses in the next 30/60/90
  days.
- **Daily Activity Report** — the client-facing document, assembled from the day's
  clock, patrol and incident data, laid out to print straight to PDF.
- **Flags** — the compliance queue: late clock-in, missed check-in, geofence violation,
  missed clock-out, early departure, no-show. Closing one requires a written outcome.
- **Incidents** — review queue with severity adjustment and notes back to the officer.
- **Sites & posts** — set each post's location **on a map** (search an address, drop or
  drag the pin, or use your current position), with the geofence drawn to scale.
  Check-in cadence, post orders and the armed flag live here too.
- **Tours** — build routes and checkpoints, and see completed walks as proof of service.
- **Audit log** — every sign-in, clock event, PIN reset and record change.

### Client portal (web, `/portal`)

A read-only window for the people paying for the guarding. A contact signs in with an
email and password — a different identity space from staff, who use an employee code and
a PIN — and sees, for their own properties only:

- **Coverage at a glance** — who is on post right now, the week's coverage percentage,
  hours on site, patrols walked and incidents.
- **Coverage record** — every scheduled shift with who stood it and when they clocked in
  and out. A shift reads *Scheduled*, then *Awaiting clock-in*, and only becomes *Not
  covered* once it has ended with nobody on it.
- **Patrol proof** — each round walked, with every checkpoint scanned, skipped or
  missed, and the time it was reached.
- **Incidents** — the full report, including photographs, which are served through the
  API rather than handed out as storage URLs.
- **Daily activity report** — the same document the account manager reviews, laid out to
  print straight to PDF.
- **Invoices** — their own issued invoices, with the hours and the rate charged.

What a client can never see: another client's property, any pay rate, classification or
margin, an officer's employment record, or the internal review notes on an incident.
`apps/server/test/portal.mjs` exists to keep that true, and checks it by walking every
response for those fields rather than trusting the queries to stay right.

### Maps

Locations use OpenStreetMap through Leaflet, so the map works with **no API key and no
billing account**. Every location also carries an *Open in Google Maps* / *Directions*
link, which is what an officer or responding supervisor actually wants.

Set `USC_MAPS_API_KEY` and address lookup switches to Google's geocoder; without it the
app falls back to OpenStreetMap's Nominatim. Either way an admin can always place the
pin by hand.

---

## Layout

```
usa-security-connect/
├─ packages/shared/        Brand tokens + business rules used by all three surfaces
├─ apps/
│  ├─ server/              Node + Express API, Postgres, JWT, compliance engine
│  ├─ web/                 React + Vite (officer app, admin console, client portal)
│  └─ mobile/              Expo / React Native (Android + iOS)
├─ api/index.js            The same Express app, as a Vercel function
└─ docs/
```

`packages/shared/src/domain.js` holds the thresholds — grace period, check-in window,
geofence radius, overtime line — so changing a rule changes it everywhere at once.

### Stack notes

- **Postgres, two drivers, one data layer.** Production uses Neon over HTTP;
  development and CI use **PGlite** — Postgres compiled to WebAssembly — so there is no
  database server to install and no Docker. Both are real Postgres running the same
  `schema.sql`, and `apps/server/src/lib/db.js` is the only file that knows which is in
  use. Money is stored in integer cents, calendar fields as `date`, events as
  `timestamptz`.
- **One Express app, two front doors.** `src/index.js` listens on a port; `api/index.js`
  exports the same app as a Vercel function. The schema is applied lazily on the first
  request, so a cold start costs one round trip and nothing afterwards.
- **PINs and portal passwords** are hashed with scrypt and a per-record salt, never
  stored or returned in readable form. Five wrong attempts locks the account for 15
  minutes; sign-in is rate limited per IP *and* per employee code or email.
- **Staff and clients are separate identity spaces.** Both tokens are signed with the
  same secret and both subjects are small integers from different tables, so each token
  carries the kind it is and each middleware refuses the other.
- **The compliance sweep** (`apps/server/src/services/compliance.js`) runs on a timer on
  a long-running host, and via `POST /api/cron/sweep` behind `CRON_SECRET` where there
  is no such process. It is idempotent — a unique constraint on the flag means running
  it repeatedly never duplicates an alert.

---

## Brand

Sampled from usasecuritygroup.com:

| Token | Value | Use |
|-------|-------|-----|
| Navy | `#001F3F` | Headers, admin sidebar, primary surfaces |
| Brand red | `#AA2F19` | Primary actions, active states |
| Accent | `#E66952` | Highlights |
| Charcoal | `#292929` | Body text |

Defined once in `packages/shared/src/theme.js`, mirrored as CSS custom properties in
`apps/web/src/styles/app.css` and as a JS object in `apps/mobile/src/theme.js`.

---

## Configuration

| Variable | Where | Default | Notes |
|----------|-------|---------|-------|
| `PORT` | server | `4000` | |
| `DATABASE_URL` | server | unset | A Postgres connection string (Neon). Without it the server uses a local PGlite database, which is what `npm run dev` does. |
| `USC_JWT_SECRET` | server | dev-only fallback | **Required in production** — the server refuses to start without it when `NODE_ENV=production`. |
| `USC_TOKEN_TTL` | server | `12h` | Staff session. Long enough for a full shift. |
| `USC_CLIENT_TOKEN_TTL` | server | `8h` | Client portal session. Shorter: they are not mid-shift. |
| `CRON_SECRET` | server | unset | Required to call `/api/cron/sweep`. Set it on any host without a long-running process. |
| `BLOB_READ_WRITE_TOKEN` | server | unset | Vercel Blob. Without it, incident photos go to `USC_DATA_DIR/uploads`. |
| `USC_DATA_DIR` | server | `apps/server/data` | Local PGlite database + incident photos, when neither of the above is set. |
| `USC_ALLOWED_ORIGINS` | server | all | Comma-separated list; set this in production. |
| `USC_MAPS_API_KEY` | server | unset | Google geocoding key. Without it, address lookup uses OpenStreetMap. |
| `USC_PUSH_DISABLED` | server | unset | Set to `1` to switch push delivery off (used by the test suite). |
| `VITE_API_URL` | web | `/api` (proxied) | |
| `EXPO_PUBLIC_API_URL` | mobile | `10.0.2.2` / `localhost` | Point at your real API for device builds. |

---

## Before going live

1. **Set `USC_JWT_SECRET`** and `USC_ALLOWED_ORIGINS`, and serve everything over HTTPS —
   PINs, passwords and tokens must never cross plain HTTP.
2. **Point `DATABASE_URL` at a real Postgres** (Neon, or anything else). PGlite is for
   development and CI; it is single-writer and lives on local disk.
3. **Set `CRON_SECRET` and schedule the sweep** if the API is serverless. Without it,
   late and missed-check-in flags are never raised. On a long-running host an internal
   timer does this and no secret is needed.
4. **Create the first administrator** with `node apps/server/tools/create-admin.mjs`.
   The demo seed must never run against production.
5. **Back up the database and the photo store**, and test the restore.
6. **Review the retention policy** for GPS traces and photos with counsel; the audit
   log, timesheets and invoices are designed to be kept, but location history may not
   need to be.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the step-by-step version.

### Shipping the apps

The Expo project is configured and bundles for both platforms, but store binaries still
need a build step this project has not run:

```bash
cd apps/mobile
npx eas build --platform android    # AAB for Google Play
npx eas build --platform ios        # needs an Apple Developer account
```

- **iOS** builds require macOS or EAS's hosted macOS builders.
- **NFC tag scanning** is built and wired to the tour screen, but the native module only
  exists in a development or production build — it will not work in Expo Go. The app
  detects this and falls back to typing the tag ID or marking the checkpoint visited;
  the server validates the tag identically either way.
- **Push notifications** are built end to end (device registration, urgent broadcasts,
  check-ins falling due, duress alerts, messages). They need `eas build:configure` to
  write a project ID into `app.json`, and FCM/APNs credentials via `npx eas credentials`.
  Until then the app logs a warning and carries on without them.

See [apps/mobile/BUILDING.md](apps/mobile/BUILDING.md) for the full build walkthrough.

---

## Tests

One command reseeds the database, starts the API, runs every suite and stops it:

```bash
npm run verify --workspace @usc/server            # add --fresh to wipe the database first
```

The order matters and the script enforces it: PGlite is single-writer, so seeding while
the server is running corrupts the data directory.

- **`test/smoke.mjs`** — authentication, PIN lockout, geofenced clock-in, status
  check-ins, tours and NFC tag validation, training enforcement, scheduling conflicts,
  the compliance sweep and the payroll export.
- **`test/features.mjs`** — employment classification rules, overtime by worker type,
  margin, certification expiry, availability, time off, breaks, duress alerts, the
  daily report, map data and push registration.
- **`test/shifts.mjs`** — open shifts, claiming, swaps and drops, and the armed-post
  licence rule from both sides.
- **`test/portal.mjs`** — client scoping, mostly negatively: that one client cannot see
  another's property, that a client token cannot reach a staff endpoint and vice versa,
  and that no pay or personnel field appears in any response.
- **`test/invoices.mjs`** — the billing arithmetic, recomputed from the hours rather
  than trusted; status transitions; and that cost and margin never reach the portal.

`npm run check:schema --workspace @usc/server` verifies every expected column and table
exists after a migration.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the rule reference — thresholds, flag
types, roles, the PIN lifecycle and the pay calculation.
