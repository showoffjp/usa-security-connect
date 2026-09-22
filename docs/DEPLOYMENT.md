# Deploying USA Security Connect

## Read this first: Vercel hosts the web app, not the API

Vercel is a great fit for the React app and a bad fit for this API. Three things in the
server need a process that stays alive and a disk that persists:

| What | Where it lives | Why serverless breaks it |
|------|----------------|--------------------------|
| SQLite database | `USC_DATA_DIR/usc.db` | Serverless filesystems are ephemeral; every invocation starts clean |
| Compliance sweep | `setInterval` every 60s | Functions are killed between requests, so late/missed/no-show flags would never fire |
| Incident photos | `USC_DATA_DIR/uploads` | Uploaded files would vanish on the next request |

So the working split is:

```
  React web app  ──►  Vercel            (static, free tier is fine)
  API + database ──►  Render / Railway  (persistent disk, always-on)
  Mobile apps    ──►  EAS Build         (see apps/mobile/BUILDING.md)
```

If you want **everything** on Vercel, the API has to move to Postgres (Neon or Supabase),
object storage for photos (Vercel Blob or S3), and a Vercel Cron job to replace the
sweep. That is a real port, not a config change — worth doing if you are heading for
multiple regions, unnecessary for a single company's guard force.

---

## 1. GitHub

The repository is committed locally with no remote. Create the repo, then:

```bash
cd usa-security-connect
git remote add origin https://github.com/<you>/usa-security-connect.git
git push -u origin main
```

`.github/workflows/ci.yml` then runs on every push: schema check, both API suites, the
web build, and a mobile bundle for Android and iOS. No secrets needed — CI generates its
own throwaway JWT secret and disables push delivery.

**Before the first push**, confirm nothing sensitive is tracked:

```bash
git ls-files | grep -Ei "\.env$|\.db$|/data/" || echo "clean"
```

`.gitignore` already excludes `.env`, `*.db` and `data/`.

---

## 2. API on Render

`render.yaml` is a blueprint — point Render at the repo and it provisions both services.
Or do it by hand:

1. **New → Web Service**, connect the repo.
2. Runtime **Docker**, Dockerfile path `apps/server/Dockerfile`, context `.`.
3. Add a **disk**: mount path `/data`, 5 GB. *This is the important step.* Without it the
   database is wiped on every deploy.
4. Environment variables:

   | Key | Value |
   |-----|-------|
   | `USC_JWT_SECRET` | Generate one. `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"` |
   | `USC_DATA_DIR` | `/data` |
   | `USC_ALLOWED_ORIGINS` | Your Vercel URL, e.g. `https://connect.usasecuritygroup.com` |
   | `USC_MAPS_API_KEY` | Optional — only for Google geocoding |

5. Health check path `/api/health`.

The server **refuses to start in production without `USC_JWT_SECRET`**, which is
deliberate — a default signing key would let anyone mint a valid admin token.

### Seeding the first administrator

The demo seed creates fake staff and must not run against production. Create the real
first admin from a one-off shell on the host:

```bash
node -e "
import('./apps/server/src/lib/db.js').then(async ({ db, migrate }) => {
  const { hashPin, generatePin } = await import('./apps/server/src/lib/auth.js');
  migrate();
  const pin = generatePin(6);
  const { hash, salt } = hashPin(pin);
  db.prepare(\`INSERT INTO users (employee_code, first_name, last_name, role, status,
    employment_type, pin_hash, pin_salt, pin_set_at, must_change_pin)
    VALUES ('1001','Vince','Ortega','admin','active','w2',?,?,datetime('now'),1)\`).run(hash, salt);
  console.log('Employee code 1001, PIN', pin, '- change it at first sign-in.');
});
"
```

Railway and Fly.io work identically from the same Dockerfile; both need a volume mounted
at `/data`.

---

## 3. Web app on Vercel

1. **Add New → Project**, import the repo.
2. Root directory **`apps/web`**. Vercel reads `apps/web/vercel.json`.
3. Environment variable:

   | Key | Value |
   |-----|-------|
   | `VITE_API_URL` | `https://your-api.onrender.com/api` |

4. Deploy, then go back to Render and set `USC_ALLOWED_ORIGINS` to the Vercel URL.

`vercel.json` also has an `/api/*` rewrite, useful if you would rather proxy through the
same origin than set `VITE_API_URL`. Replace `REPLACE-WITH-YOUR-API-HOST` if you use it.

The SPA rewrite is already configured, so deep links like `/admin/timesheets` resolve
instead of 404ing.

---

## 4. Mobile

See [apps/mobile/BUILDING.md](../apps/mobile/BUILDING.md). Point the build profiles in
`apps/mobile/eas.json` at the deployed API before building:

```json
"env": { "EXPO_PUBLIC_API_URL": "https://your-api.onrender.com/api" }
```

---

## Going further

- **Custom domain.** Vercel handles TLS automatically. Officers will be typing this on a
  phone at 2am, so keep it short.
- **Backups.** The whole system is one SQLite file plus the uploads directory. A nightly
  `cp` of `/data` to object storage is a complete backup. Test the restore.
- **Postgres.** Worth it when you need more than one API instance. The queries are plain
  SQL and the driver is isolated in `apps/server/src/lib/db.js`, so it is a contained
  change rather than a rewrite.
- **Retention.** Decide how long GPS traces on check-ins are kept. The audit log and
  timesheets are designed to be kept; location history probably should not be.
