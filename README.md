# USA Security Connect

Workforce operations platform for **USA Security & Protection Group** — guard tour, time
and attendance, incident reporting and supervision, in one system:

- a **web app** for officers *and* the admin console, and
- a **mobile app** built from one codebase for **Android and iPhone**.

Both talk to the same API, and the rules that decide "late", "missed check-in" or
"outside the geofence" live in one shared module so the three surfaces can never
disagree with each other.

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
| `1001` | `2468` | Vince Ortega | Administrator — full admin console |
| `1002` | `3571` | Renata Diaz | Field supervisor |
| `1003` | `4812` | Marcus Bell | Officer, **currently on post** |
| `1004` | `5930` | Janelle Carter | Officer |
| `1005` | `6174` | Dwayne Foster | Officer, armed post |
| `1006` | `7285` | Alicia Nunez | Officer |
| `1007` | `8140` | Kevin Osei | New hire — forced to change PIN at first sign-in |

> These fixed PINs exist only in the demo seed. Real accounts get a random PIN
> generated in the admin console and shown exactly once.

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

### Admin console (web)

- **Live dashboard** — who is on post right now, minutes on post, missed check-ins,
  officers outside their geofence, unfilled shifts.
- **Employees** — full records, licence tracking with expiry warnings, role and status,
  account unlock, and **PIN generation/reset shown once**.
- **Schedule** — week grid, drag-free editing, conflict detection, and a recurring
  roster builder that handles overnight shifts.
- **Timesheets** — hours by officer with regular/overtime split, exception badges,
  estimated cost, every individual punch, and **CSV export for payroll**.
- **Flags** — the compliance queue: late clock-in, missed check-in, geofence violation,
  missed clock-out, early departure, no-show. Closing one requires a written outcome.
- **Incidents** — review queue with severity adjustment and notes back to the officer.
- **Sites & posts** — geofence radius, check-in cadence, post orders, armed flag.
- **Tours** — build routes and checkpoints, and see completed walks as proof of service.
- **Audit log** — every sign-in, clock event, PIN reset and record change.

---

## Layout

```
usa-security-connect/
├─ packages/shared/        Brand tokens + business rules used by all three surfaces
├─ apps/
│  ├─ server/              Node + Express API, SQLite, JWT, compliance engine
│  ├─ web/                 React + Vite (officer app + admin console)
│  └─ mobile/              Expo / React Native (Android + iOS)
└─ docs/
```

`packages/shared/src/domain.js` holds the thresholds — grace period, check-in window,
geofence radius, overtime line — so changing a rule changes it everywhere at once.

### Stack notes

- **SQLite via `node:sqlite`** (built into Node 22.5+). No native build step, so the
  API installs and deploys on any plain Node host. `apps/server/src/lib/db.js` wraps it
  in a `better-sqlite3`-shaped adapter, so swapping drivers later touches one file.
- **PINs** are hashed with scrypt and a per-user salt, never stored or returned in
  readable form. Five wrong attempts locks the account for 15 minutes; login is rate
  limited per IP *and* per employee code.
- **The compliance sweep** (`apps/server/src/services/compliance.js`) runs every minute
  and on every admin dashboard load. It is idempotent — a unique constraint on the flag
  means running it repeatedly never duplicates an alert.

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
| `USC_JWT_SECRET` | server | dev-only fallback | **Required in production** — the server refuses to start without it when `NODE_ENV=production`. |
| `USC_TOKEN_TTL` | server | `12h` | Long enough for a full shift. |
| `USC_DATA_DIR` | server | `apps/server/data` | SQLite file + incident photos. |
| `USC_ALLOWED_ORIGINS` | server | all | Comma-separated list; set this in production. |
| `VITE_API_URL` | web | `/api` (proxied) | |
| `EXPO_PUBLIC_API_URL` | mobile | `10.0.2.2` / `localhost` | Point at your real API for device builds. |

---

## Before going live

1. **Set `USC_JWT_SECRET`** and `USC_ALLOWED_ORIGINS`, and serve everything over HTTPS —
   PINs and tokens must never cross plain HTTP.
2. **Swap SQLite for Postgres** if more than one API instance will run. The queries are
   plain SQL and the data layer is isolated in `lib/db.js`.
3. **Back up `USC_DATA_DIR`** — it holds the database and every incident photo.
4. **Review the retention policy** for GPS traces and photos with counsel; the audit log
   is designed to be kept, but location history may not need to be.

### Shipping the apps

The Expo project is configured and bundles for both platforms, but store binaries still
need a build step this project has not run:

```bash
cd apps/mobile
npx eas build --platform android    # AAB for Google Play
npx eas build --platform ios        # needs an Apple Developer account
```

- **iOS** builds require macOS or EAS's hosted macOS builders.
- **NFC tag scanning** needs a development build (`npx expo prebuild`) plus
  `react-native-nfc-manager`; it will not work in Expo Go. Until then, every checkpoint
  can be completed by typing its tag ID or marking it visited, which is already wired up.
- **Push notifications** for urgent broadcasts and overdue check-ins are not built yet —
  `expo-notifications` plus a device-token table is the natural next step.

---

## Tests

`npm run seed` followed by the API smoke checks exercises authentication, lockout,
geofencing, the compliance sweep, scheduling conflicts, tour rules, training
enforcement and the payroll export. See `docs/OPERATIONS.md` for the rule reference.
