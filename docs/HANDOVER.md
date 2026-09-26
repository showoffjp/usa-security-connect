# Handover

What was built, why it is shaped the way it is, what is not finished, and what
will bite you first. Written for whoever picks this up next — possibly you, in
six months, having forgotten all of it.

- [README.md](../README.md) — what the system does, feature by feature
- [docs/DEPLOYMENT.md](DEPLOYMENT.md) — getting it running on Vercel + Neon
- [docs/OPERATIONS.md](OPERATIONS.md) — the rule reference: thresholds, flags,
  roles, the PIN lifecycle, the pay calculation

---

## The shape of it

Four surfaces, one API, one set of rules:

| Surface | Who | Where |
|---------|-----|-------|
| Officer app | Guards on post | web `/`, and the mobile app |
| Admin console | Supervisors and administrators | web `/admin` |
| Client portal | The people paying for the guarding | web `/portal` |
| API | All three | `apps/server`, deployed as one Vercel function |

**`packages/shared/src/domain.js` is the spine.** Grace periods, the check-in
window, geofence evaluation, overtime by employment type, licence expiry,
shift eligibility, invoice arithmetic — all of it lives there and is imported
by the API, the web app and the mobile app. Change a rule once and all three
agree. If you are ever tempted to reimplement a rule "just for the UI", that
is the mistake this layout exists to prevent.

The API can never trust the client, so every rule is enforced server-side too.
The shared module is about *agreement*, not about trusting the browser.

### Three things capture once and are used many times

This is the design idea the whole thing rests on:

1. An officer clocks in. That single `time_entries` row becomes their
   timesheet, the compliance flag if they were late, the client's coverage
   record, the daily activity report, and the invoice line.
2. An officer scans a checkpoint. That becomes patrol proof for the client and
   evidence of service for the contract.
3. An officer files an incident. That becomes the review queue, the daily
   report, and the client's incident history.

Nothing is typed twice, so nothing can disagree with itself. When adding a
feature, ask what already captures the data before adding a new place to type
it in.

---

## Why the unusual choices

**Postgres with two drivers.** Production is Neon over HTTP. Development and
CI use PGlite — Postgres compiled to WebAssembly — so there is no database
server to install, no Docker, and CI needs no service container. Both run the
same schema, `apps/server/src/lib/schema.js`. `apps/server/src/lib/db.js` is the only file that knows
which is in use.

PGlite is **single-writer**. Seeding while the API is running corrupts the
data directory, which is why `tools/verify.mjs` enforces seed-then-start
rather than leaving it to whoever runs it. If you ever see
`unexpected data beyond EOF in block 0`, that is what happened: stop
everything, `npm run verify --fresh`.

**The data layer translates SQLite-isms.** The project started on SQLite, and
rather than rewrite 300 queries the translation lives in one place —
`toPostgres()` in `db.js`. `datetime('now')` becomes `now()`, `date(x)`
becomes `x::date`, boolean comparisons against `0`/`1` become `false`/`true`.
`test/dialect.mjs` is a pure unit test of exactly that and runs first, because
if the translation is wrong every other failure is noise. New queries can be
written in either dialect; plain Postgres is preferred for anything new.

**Money is integer cents, everywhere.** No floats touch a currency value.
`date` columns are calendar days and come back as `'YYYY-MM-DD'` strings
because a type parser makes them so — see the trap below. Events are
`timestamptz`.

**Staff and clients are separate identity spaces.** Officers sign in with an
employee code and a PIN; client contacts with an email and a password. Both
tokens are signed with the same secret, and both subjects are small integers
from *different tables*. So each token carries the kind it is, and each
middleware refuses the other. `test/portal.mjs` checks this in both
directions; do not remove those checks.

**One Express app, two front doors.** `src/index.js` listens on a port for
local dev and any ordinary host; `api/index.js` exports the same app as a
Vercel function. The schema is applied lazily on first request, memoised, so a
cold start costs one round trip.

---

## Traps that have already bitten

Each of these was a real bug, found by the test suites. They are the things
most likely to recur.

**Calendar dates are not instants.** `new Date('2026-09-22')` is UTC midnight,
which is the previous evening in Florida. A report asked for by date silently
covered the wrong 24 hours. Fixed in three places, and they must stay fixed:
`parseDay()`/`toDateString()` in `lib/http.js` for query parameters, the
`DATE_OID` type parser in `db.js` so `date` columns arrive as text, and
`toDate()` in both `format.js` files so a bare `YYYY-MM-DD` renders in local
time. Never call `new Date()` on a bare date string.

**`db.transaction(fn)` returns a callable.** You must invoke it:
`await db.transaction(async () => { ... })()`. Awaiting the function instead of
calling it silently does nothing at all and still returns 201. There are eight
call sites; all end in `})();`.

**Status vocabularies.** Checkpoints are `done` / `skipped` / `pending` — not
"scanned", even though the client-facing wording says scanned. A query written
against the wrong literal returns zero without erroring, which is how every
portal patrol count was silently zero for a while.

**`Array.map(async ...)` returns promises, not results.** The seed produced one
time entry instead of forty-eight because of this. Sequential `for...of` in
anything that touches the database.

**An `<img src>` cannot carry a bearer token.** Incident photos are served
through the API so they stay behind auth, which means they must be fetched and
handed over as an object URL. That is what `components/AuthedImage.jsx` is for.
Both staff screens had plain `<img src>` and never loaded a single photo.

**`SUM(boolean)` is not valid Postgres.** Use
`SUM(CASE WHEN x THEN 1 ELSE 0 END)`. Likewise `GROUP_CONCAT` is `string_agg`.

**Never put a secret in an email.** `services/email.js` composes the portal
invitation and reset notices and deliberately omits the password; `email.mjs`
asserts the generated password does not appear in the body. If you add a
message, add the check too.

---

## Testing

```bash
npm run verify --workspace @usc/server            # everything, in the right order
npm run verify --workspace @usc/server -- --fresh # wipe the database first
```

584 checks across eleven suites. The counts below are what the run reports. `verify.mjs` reseeds, starts the API, runs each
suite and stops it. CI runs exactly this, plus the web build and a mobile
bundle for both platforms.

| Suite | Checks | Covers |
|-------|--------|--------|
| `dialect.mjs` | 9 | SQL translation (no server needed) |
| `smoke.mjs` | 45 | auth, lockout, geofencing, tours, training, scheduling, payroll export |
| `features.mjs` | 65 | classification, overtime, margin, certifications, time off, breaks, duress, DAR, maps, photos, push, the cron sweep |
| `shifts.mjs` | 31 | open shifts, claims, swaps, drops, the armed-post licence rule |
| `portal.mjs` | 81 | client scoping, token separation, and that no pay data leaks |
| `invoices.mjs` | 55 | billing arithmetic, status transitions, what clients may see |
| `email.mjs` | 32 | what is composed and addressed, and that no password is in it |
| `security.mjs` | 24 | set-password links, and the shared rate limiter |
| `roles.mjs` | 51 | what each staff tier can and cannot reach |
| `tracking.mjs` | 122 | location reports, walk-off flags, the live board, GPS tracks, the punch log, pay-rate changes and history, bulk raises, every report (overtime recomputed from raw punches), effective-dated rates, Timesheets / reports / invoice cost agreeing to the cent, ranking who can cover a shift, eligibility enforced on direct assignment with an audited override, copying a week |
| `payroll.mjs` | 69 | pay periods in whole payroll weeks, per-officer approval pinned to a fingerprint of the hours and rates, "changed since approved" after a corrected punch, overtime checked against the raw hours and pay against the reports to the cent, closing, every back-door change to a closed period refused (punch corrections, moving an entry in, back-dated and bulk rates), reopening with a reason, the payroll register CSV, the audit trail |

`verify.mjs` gives the API under test a cron secret, a two-second ping-thinning
gap and a larger login allowance. Each is an environment variable with a
production default; none of them should be set in production.

There is also an accessibility audit, run separately because it needs a
browser: `npm run test:a11y --workspace @usc/web` drives all 44 screens
through axe-core with the API and web app running.

**The suites are mostly adversarial, deliberately.** `portal.mjs` walks every
response looking for forbidden keys rather than trusting the SELECT lists;
`invoices.mjs` recomputes the totals from the hours rather than trusting the
numbers the API reports about itself. When you add a feature that touches
money or client visibility, add the check that would catch you getting it
wrong, not the one that confirms it worked once.

There is no browser test runner. The UI was checked by driving it in a real
browser. If this grows, Playwright is the obvious next step.

---

## Not finished

Honest list. None of it blocks going live, but you will want to know.

- **Nobody has run this against a real Neon database.** Every test runs on
  PGlite. The drivers are behind one interface and the SQL is the same, but
  the first deploy is the first real exercise of the Neon path. Test it with
  a throwaway Neon project before pointing a client at it.
- **The mobile app has never been built for a store.** It bundles for Android
  and iOS in CI, which catches import and syntax errors across every screen,
  but no `eas build` has produced a binary. NFC and push both need a
  development build — they degrade gracefully in Expo Go, which is what CI
  exercises. See `apps/mobile/BUILDING.md`.
- **Email is built but not switched on.** `services/email.js` composes and
  records every message; delivery needs `USC_EMAIL_API_KEY` (Resend) and
  `USC_EMAIL_FROM` with a verified sending domain. Until then everything lands
  in the outbox as 'skipped' and an admin sends it by hand from there. Only
  two moments send anything today: an invoice being issued, and a portal
  account being created or reset. Broadcasts and flag alerts are still
  in-app only.
- **Nothing is emailed automatically until a provider is configured.** Portal
  invitations and invoice notices land in the outbox as 'skipped' and an admin
  sends them by hand from there.
- **Your company details are not filled in.** `COMPANY` in
  `packages/shared/src/domain.js` has only the name and the state licence
  number, because those are the only two facts this project knows. The address,
  phone, email and payment instructions are blank and are simply omitted from
  the printed invoice; the admin console says so on every invoice until they
  are set. Fill them in before sending one to a client.
- **Invoice cost is base pay only.** The overtime premium accrues to an
  officer's week, not to one client's site, and apportioning it across sites is
  a judgement call nobody has made yet. Margin is therefore slightly
  optimistic on weeks with overtime. This is stated in the UI.
- **Rate-limit counters are rows, and they are written on every login
  attempt.** That is one extra write per attempt. It is the right trade at this
  size; at a much larger one it belongs in a KV store.
- **The accessibility audit needs a browser on the machine.** It drives
  whichever Chromium-based browser is installed rather than downloading
  Playwright's own, so CI would need `npx playwright install chromium` or a
  runner image with Chrome. It is not wired into CI for that reason - run it
  yourself with `npm run test:a11y --workspace @usc/web`.
- **Location retention is a default, not a decision.** The sweep deletes location
  reports older than 90 days (`RULES.locationRetentionDays`). Positions on
  clock-in, clock-out and check-in rows are kept with the hours they prove.
  Confirm the period with counsel.
- **Tracking is foreground-only on mobile.** The phone reports while the app is
  open. Tracking with the app closed needs background location permission and a
  store review that asks why; decide whether the company wants that before
  building it.
- **Payroll close has no pay date or provider hand-off.** A closed period exports
  a register CSV for the bookkeeper or payroll provider; nothing is sent to ADP,
  Gusto or a bank. Deductions, taxes and net pay are the provider's job.
- **A change of pay basis is not effective-dated.** Moving somebody from hourly to
  salary is recorded in the history, but reports price by the basis on the
  record now.

---

## If you change one thing, know this

- **Changing how hours are priced:** `apps/server/src/services/payroll.js`.
  Reports, Timesheets and invoice cost all go through it, and
  `test/tracking.mjs` checks the three agree to the cent.
- **Closing payroll:** `apps/server/src/services/payPeriods.js`. An approval is
  pinned to a fingerprint of the officer's entries and rates, so anything that
  changes their pay makes it read "changed" without anyone invalidating it. If
  you add something that writes to `time_entries` or `pay_rate_history` for a
  past date, call `assertHoursOpen` or `assertRateDateOpen` first, as the punch
  correction and pay-rate routes do.
- **Changing a threshold** (grace period, check-in window, overtime line):
  `packages/shared/src/domain.js`, `RULES`. Nowhere else.
- **Adding a table:** `apps/server/src/lib/schema.js`, then add it to the
  `tables` array in `seed.js` so `--reset` clears it, and to
  `TABLES_WITHOUT_ID` in `db.js` if it has no `id` column.
- **Adding a field a client must not see:** add it to the `FORBIDDEN` pattern
  in `test/portal.mjs`. The portal returns explicit column lists, but the test
  is what stops the next person from adding `SELECT *`.
- **Adding a route:** mount it in `app.js`. Anything under `/api/admin` needs
  `requireRole`; anything for clients goes through `requireClient`, which
  scopes it to their sites.

---

## The demo data

`npm run seed --workspace @usc/server -- --reset` builds a full working
company in about seven seconds: ten client sites from Pensacola to Miami,
sixteen posts (three armed), 43 staff across both employment types, around
640 shifts over a month, 320 worked with breaks and check-ins, 6,000+ GPS
points, 23 incidents, six tours with run history, six client portal logins and
eight invoices. Sign-in codes are printed at the end of the seed; the README
lists the useful ones.

The first four sites and eight people come from `seed.js` and are what the
older suites are written against. Everything else comes from
`seed-expansion.js`, which is placed relative to the moment the seed runs and
classified by time rather than by day - so whatever hour it is, the live board
has officers on post, one walking off, one on a break, one with a silent phone,
one late, one no-show and one post running with nobody on it. Randomness is
seeded, so two runs at the same moment give the same company.

It is shaped to exercise the rules, not just to look full: one officer's
licence is expiring, one is a 1099 contractor on an armed post, one must
change their PIN, there is an overdue invoice and an open armed shift that
only one officer is eligible for. **Never run it against production** — that
is what `tools/create-admin.mjs` is for.
