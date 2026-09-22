# Deploying USA Security Connect

Everything runs on Vercel: the React app, the API as a serverless function, and the
compliance sweep as a cron job. The database is Neon (serverless Postgres) and incident
photos go to Vercel Blob.

```
  Web app + client portal  ──►  Vercel  (static build)
  API                      ──►  Vercel  (api/index.js, one function)
  Database                 ──►  Neon    (serverless Postgres)
  Photos                   ──►  Vercel Blob
  Compliance sweep         ──►  Vercel Cron, every 5 minutes
  Mobile apps              ──►  EAS Build (see apps/mobile/BUILDING.md)
```

You need three accounts: GitHub, Vercel, Neon. All three have a free tier that comfortably
covers a single company's guard force.

> **Local development needs none of this.** `npm run dev` uses PGlite — Postgres compiled
> to WebAssembly, living in `apps/server/data/pgdata`. No database server, no Docker,
> no cloud account. `npm run verify` reseeds, starts the API and runs all six suites.

---

## 1. GitHub

The repository is committed locally with no remote. Create an **empty** repo on GitHub
(no README, no .gitignore — the repo already has both), then:

```bash
git remote add origin https://github.com/<you>/usa-security-connect.git
git push -u origin main
```

On Windows, if you hit `Filename too long`:

```bash
git config --global core.longpaths true
```

`.github/workflows/ci.yml` then runs on every push: all six API suites (which seed a
fresh database and so exercise the schema), the web build, and a mobile bundle for
Android and iOS. No secrets needed — CI generates a throwaway JWT secret, runs against a
local PGlite database and disables push delivery.

**Before the first push**, confirm nothing sensitive is tracked:

```bash
git ls-files | grep -Ei "\.env$|\.db$|/data/|pgdata" || echo "clean"
```

---

## 2. Neon database

1. Create a project at [neon.tech](https://neon.tech). Pick the region nearest your Vercel
   region — every API request makes a round trip, so this is the single biggest lever on
   response time.
2. Copy the **pooled** connection string. It looks like:
   `postgresql://user:pass@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`

   Use the pooled one (`-pooler` in the host). Serverless functions open a connection per
   invocation and the direct endpoint will run out of connections under load.

You do not need to create any tables. The API applies `apps/server/src/lib/schema.sql` on
its first request after a cold start; the file is idempotent, so it is safe to run
repeatedly and safe to redeploy over.

---

## 3. Vercel

1. **Add New → Project**, import the repo.
2. Leave the root directory as the repository root. Vercel reads `vercel.json`, which
   already sets the build command, the output directory, the function runtime, the SPA
   rewrite and the cron schedule.
3. Environment variables (Production, Preview and Development):

   | Key | Value | Required |
   |-----|-------|----------|
   | `DATABASE_URL` | The pooled Neon string from step 2 | yes |
   | `USC_JWT_SECRET` | A long random string — see below | yes |
   | `CRON_SECRET` | A second long random string | yes |
   | `BLOB_READ_WRITE_TOKEN` | Added automatically when you create a Blob store | for photos |
   | `USC_ALLOWED_ORIGINS` | Your own domain, e.g. `https://connect.usasecuritygroup.com` | recommended |
   | `USC_MAPS_API_KEY` | Only for Google geocoding; maps work without it | no |

   Generate the two secrets:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

   The API **refuses to start in production without `USC_JWT_SECRET`**, which is
   deliberate: a default signing key would let anyone mint a valid admin token.

4. **Storage → Create → Blob**, and connect it to the project. That sets
   `BLOB_READ_WRITE_TOKEN` for you. Without it the API falls back to local disk, which on
   Vercel means photos vanish between requests.

5. Deploy. Check `https://your-app.vercel.app/api/health` — it should return JSON. The
   first request after a deploy is slower because it applies the schema.

### The cron job

`vercel.json` already registers `/api/cron/sweep` every five minutes. That is what raises
late, missed-check-in and no-show flags, and auto-closes abandoned shifts. It is
authenticated with `CRON_SECRET`, so set that variable or the endpoint returns 503.

Confirm it after the first deploy: **Project → Cron Jobs** should list one job with a
recent successful run. If flags never appear, this is the first thing to check.

---

## 4. First administrator

The demo seed creates fake staff and must never run against production. Create the real
first administrator instead. From the project root, with `DATABASE_URL` set to your Neon
string:

```bash
node apps/server/tools/create-admin.mjs "Vince" "Ortega" vince@usasecuritygroup.com
```

It prints an employee code and a one-time PIN. That account must change its PIN at first
sign-in, and it can then create everyone else from **Employees**.

---

## 5. Client portal

The portal is part of the same deployment, at `/portal`. Nothing extra to configure.

Give a site contact access from **Billing → Client portal → New login**: their email,
their name, and the properties they may see. The generated password is shown once —
send it to them, then they change it from their own account menu.

A client sees coverage, patrol proof, incidents, the daily activity report and their own
issued invoices, for their own sites only. They never see pay rates, margin, another
client's property, or an officer's employment record. `apps/server/test/portal.mjs`
exists to keep that true.

---

## 6. Mobile

See [apps/mobile/BUILDING.md](../apps/mobile/BUILDING.md). Point the build profiles in
`apps/mobile/eas.json` at the deployed API before building:

```json
"env": { "EXPO_PUBLIC_API_URL": "https://your-app.vercel.app/api" }
```

---

## Operating notes

- **Cold starts.** The first request after an idle period pays for the function starting
  and the schema check. Officers clocking in at shift change will not notice; it is worth
  knowing when someone reports "the first tap was slow".
- **Backups.** Neon keeps point-in-time restore on its paid tiers and a daily backup on
  the free one. Photos in Blob are separate — decide whether you need them backed up, and
  test a restore before you rely on either.
- **Connection limits.** If you see `too many connections`, you are on the direct Neon
  endpoint rather than the pooled one. Check the `-pooler` host in `DATABASE_URL`.
- **Retention.** Decide how long GPS traces on check-ins are kept. The audit log,
  timesheets and invoices are designed to be kept; location history probably should not
  be.
- **Custom domain.** Vercel handles TLS automatically. Officers type this on a phone at
  2am, so keep it short.

### Running it somewhere else

Nothing here is Vercel-specific beyond the config file. `apps/server/src/index.js` is an
ordinary Express server, `apps/server/Dockerfile` builds it, and `render.yaml` is kept as
a working blueprint for Render. On a long-running host the compliance sweep runs on an
internal timer and you do not need `CRON_SECRET`. Any Postgres works in place of Neon —
set `DATABASE_URL` and the driver in `apps/server/src/lib/db.js` handles the rest.
