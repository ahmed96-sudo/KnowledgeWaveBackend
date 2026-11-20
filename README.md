# KnowledgeWave Backend

Express 5 + TypeScript + Prisma 7 + PostgreSQL. Contract: [`BACKEND_SPEC.md`](./BACKEND_SPEC.md). All routes are under **`/api`** (no `/v1`).

## Run it

```bash
cp .env.example .env            # first time only
docker compose up -d            # Postgres :5432, Adminer :8080, Mailpit :8025 (UI) / :1025 (SMTP)
npm install
npx prisma migrate dev          # applies prisma/migrations to the dev DB
npm run seed                    # catalog, demo accounts, coupons (safe to run again)
npm run dev                     # http://localhost:4000/api/health
npm test                        # Vitest + Supertest (uses the knowledgewave_test DB)
```

- Adminer: http://localhost:8080 (System: PostgreSQL, **Server: `db`**, user/password: `postgres`, DB: `knowledgewave`)
- Mailpit inbox: http://localhost:8025 (password-reset and newsletter emails land here; the contact form goes to `CONTACT_TO`)
- Prisma 7 does **not** seed after `migrate reset`: run `npm run seed` yourself.
- Reset the dev DB: `npx prisma migrate reset --force && npm run seed`
- Reset the test DB: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/knowledgewave_test npx prisma migrate reset --force`
  (`npm test` also applies pending migrations to the test DB by itself.)
- If the Postgres volume already existed before `docker/init-test-db.sql` was added, create the test DB once:
  `docker exec knowledgewave_db psql -U postgres -c "CREATE DATABASE knowledgewave_test"`
- `src/generated/` (Prisma client) is git-ignored; `npm run db:generate` rebuilds it.

Demo accounts (password `demo1234`): `student@knowledgewave.dev`, `instructor@knowledgewave.dev`, `admin@knowledgewave.dev`.

## Layout

```
src/config.ts        validated env
src/app.ts           express app (exported for Supertest) · src/server.ts starts it + hourly purge
src/auth/            sessions, passwords, register/login/logout/me, change + reset password   (routes → controller → service)
src/site/            contact form + newsletter                                                  (routes → controller → service)
src/lib/             errors (ApiError + codes), prisma client, mail (nodemailer → Mailpit), money, slug, localized, purge
src/middleware/      validate (Zod), csrf, auth guards (requireAuth / requireRole / requireRealAdmin), rate limits, errors
src/schemas/         Zod contracts copied from the frontend (BACKEND_SPEC Appendix A)
src/seed.ts          loads seed/*.json (prisma/seed.ts is the runner)
storage/             uploaded files (contents git-ignored, folder kept)
prisma/              schema + migrations
```

## Auth in short

- Session cookie `kw_sid` (httpOnly, SameSite=Lax, Secure in production, 7-day rolling expiry). The DB stores only its SHA-256 hash, so deleting the row (logout, ban, password change) ends the session immediately.
- Readable hint cookies `kw_session=<role>` and `kw_actor=admin` are set/cleared with it for the Next proxy; the API never trusts them.
- CSRF: every non-GET request must send `X-Requested-With: fetch`, and if it carries an `Origin` header (browsers always do) it must equal `CORS_ORIGIN`; otherwise `403 forbidden`. Requests without `Origin` (curl, server-to-server) only need the header. No frontend change beyond the header: browsers add `Origin` themselves.
- `POST /auth/change-password` always changes the **real** signed-in user's password (an admin acting as a student changes their own).
- Password reset: `POST /auth/forgot-password` always answers 204 and emails a link (valid 10 minutes, single use, newest link wins) to `FRONTEND_URL/reset-password?token=…`; `POST /auth/reset-password { token, next }` sets the password and ends all sessions.
- Rate limits (per IP, in-memory): login 10 / 15 min, register 10 / h, forgot-password 5 / h, reset-password 10 / h, contact 5 / h, newsletter 10 / h.

## Before deploying

- Behind a reverse proxy (nginx, a load balancer), set `TRUST_PROXY=1` (number of proxies). Without it every user looks like the proxy's IP and shares one rate-limit bucket. Leave it empty locally.
- Set `NODE_ENV=production` (Secure cookies), `API_PUBLIC_URL` and `FRONTEND_URL`.

## Languages

Bilingual content is stored as JSONB `{ "en": "...", "ar": "..." }` (the exact API shape). The supported/required locales live in one place: `src/lib/localized.ts`. Adding a language = append it to `LOCALES` (stays optional, falls back to `en`), add its text to the backend-generated notification templates, and do the frontend side; no DB migration.

## Frontend work still to do (when the backend is finished)

1. Switch the frontend's `/api/v1` to `/api` (Next rewrite, fetch base, asset stream URL in `docs/CONNECT_BACKEND.md`).
2. Send `X-Requested-With: fetch` on every non-GET request, and `credentials: "include"` on every request.
3. Add a `/reset-password` page + `api.resetPassword`, and make `api.forgotPassword` call the real endpoint (links in the email expire after 10 minutes).
4. While acting as another user, show a notice on the change-password form: "You are acting as another user: this changes your admin password" (the endpoint changes the real admin's password). There is no admin settings page today.
5. Client side of `Idempotency-Key` headers (`docs/CONNECT_BACKEND.md` §6a).
