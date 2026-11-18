# KnowledgeWave Backend

Express 5 + TypeScript + Prisma 7 + PostgreSQL. Contract: [`BACKEND_SPEC.md`](./BACKEND_SPEC.md). All routes are under **`/api`** (no `/v1`).

## Run it

```bash
cp .env.example .env            # first time only
docker compose up -d            # Postgres :5432, Adminer :8080, Mailpit :8025 (UI) / :1025 (SMTP)
npm install
npx prisma migrate dev          # applies prisma/migrations to the dev DB
npm run dev                     # http://localhost:4000/api/health
npm test                        # Vitest + Supertest (uses the knowledgewave_test DB)
```

- Adminer: http://localhost:8080 (System: PostgreSQL, Server: `db`, user/password: `postgres`, DB: `knowledgewave`)
- Mailpit inbox: http://localhost:8025
- If the Postgres volume already existed before `docker/init-test-db.sql` was added, create the test DB once:
  `docker exec knowledgewave_db psql -U postgres -c "CREATE DATABASE knowledgewave_test"`
- Apply migrations to the test DB: `DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy`
- `src/generated/` (Prisma client) is git-ignored; `npm run db:generate` rebuilds it.

## Layout

```
src/config.ts        validated env
src/app.ts           express app (exported for Supertest) · src/server.ts starts it
src/lib/             errors (ApiError + codes), prisma client, mail (nodemailer → Mailpit)
src/middleware/      validate (Zod), error handlers
src/routes/          router per area, mounted in routes/index.ts
storage/             uploaded files (contents git-ignored, folder kept)
prisma/              schema + migrations
```

## Languages

Bilingual content is stored as JSONB `{ "en": "...", "ar": "..." }` (the exact API shape). The supported/required locales live in one place: `src/lib/localized.ts`. Adding a language = append it to `LOCALES` (stays optional, falls back to `en`), add its text to the backend-generated notification templates, and do the frontend side; no DB migration.

## Frontend work still to do (when the backend is finished)

1. Switch the frontend's `/api/v1` to `/api` (Next rewrite, fetch base, asset stream URL in `docs/CONNECT_BACKEND.md`).
2. Add a `/reset-password` page + `api.resetPassword`, and make `api.forgotPassword` call the real endpoint (links in the email expire after 10 minutes).
3. Client side of `Idempotency-Key` headers (`docs/CONNECT_BACKEND.md` §6a).
