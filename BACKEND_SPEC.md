# KnowledgeWave Backend Specification

**Audience:** an engineer or AI agent starting the Node.js/Express backend for the KnowledgeWave frontend, with no other context.
**Goal:** after building this, the existing Next.js frontend can switch from its in-browser mock to this API by replacing only the bodies of the functions in `src/lib/api/` (see `CONNECT_BACKEND.md`). Nothing in this document should require changing UI components.
**Source of truth:** the frontend repo. Every type below is copied from `src/lib/schemas/*` (Appendix A) and every endpoint maps 1:1 to a function in `src/lib/api/{index,student,instructor,admin}.ts`. When this document and the frontend code disagree, the frontend code wins; tell the user.

---

## 0. What KnowledgeWave is

A bilingual (English/Arabic) e-learning platform. Three roles:

- **student**: browses and buys courses, watches lessons (YouTube embeds or instructor-uploaded video), takes notes, asks questions, takes quizzes, earns XP/levels/badges/streaks/certificates, writes reviews.
- **instructor**: builds courses (sections → lessons → optional quiz), publishes/unpublishes/archives/deletes them, sees students, answers Q&A, sees earnings and analytics.
- **admin**: manages users (edit, role, ban, reset password, soft-delete), courses, orders (refunds), reviews (hide), categories, coupons; sees an audit log with revert/redo; can **act as** another user.

All user-facing content is bilingual: `{ en: string, ar: string }` (type `Localized`). The backend stores and returns both languages; it never translates.

---

## 1. Stack and structure (recommended)

| Concern | Recommendation |
| --- | --- |
| Runtime | Node 20+, **Express** + **TypeScript** (strict) |
| Structure | `routes → middleware → controllers → services → data layer` (one folder per area: `auth`, `catalog`, `learning`, `instructor`, `admin`, `uploads`) |
| Validation | **Zod** (the frontend already uses Zod 4; copy Appendix A's schemas into `src/schemas` so request/response validation is identical) |
| Database | **PostgreSQL** (relational model in §3). SQLite is fine for local development. Use an ORM/query builder with migrations (Drizzle, Prisma or Knex) |
| Sessions | **Server-side session cookie**, not JWT (§2) |
| Passwords | argon2id (or bcrypt cost ≥ 12) |
| File storage | Local disk in development; S3-compatible (S3/R2/MinIO) in production, via presigned URLs (§9) |
| Config | `.env` + a validated config module (port, DB URL, session secret, CORS origin, upload limits, cookie settings) |
| Tests | Vitest/Jest + Supertest against a test database |

The frontend runs on `http://localhost:3000` in development. CORS: allow that origin **with credentials**.

---

## 2. Conventions

### 2.1 Base path, format, auth

- Base path: `/api/v1`. JSON request and response bodies, UTF-8, `Content-Type: application/json`.
- **Authentication = httpOnly session cookie.** Login sets e.g. `kw_sid` (httpOnly, `SameSite=Lax`, `Secure` in production, 7-day rolling expiry). The session row/Redis entry holds `userId` and, while an admin is acting as someone, `actingAsUserId` (§2.4).
- The frontend additionally sets two *non-sensitive, readable* cookies for Next's proxy (UX routing only): `kw_session=<role>` and `kw_actor=admin`. The backend should set/clear them in the same responses as the session cookie so the frontend does not have to (see `CONNECT_BACKEND.md` §3). They are hints, never trusted by the API.
- **CSRF**: cookies + `SameSite=Lax` + JSON-only bodies protect most flows; additionally require a custom header (`X-Requested-With: fetch` or a double-submit token) on every non-GET request.
- Unauthenticated requests to protected routes return `401`. Wrong role returns `403`.

### 2.2 IDs, dates, money

- Dates/times: ISO-8601 strings in UTC (`2026-03-01T09:00:00.000Z`). Course `updatedAt` and review `date` use calendar dates (`YYYY-MM-DD`) as in the seed data.
- Learning activity is keyed by the **learner's local calendar day** (`YYYY-MM-DD`) because "today" and streaks must match their clock. The client sends the day key in the progress save (§6, `PUT /me/progress`), and the server stores it as given.
- Money: **USD**, JSON numbers with 2 decimals max (store integer cents in the database, convert at the edge). Discounts round to cents.
- Ids: `User.id` etc. are opaque strings. Course/category/roadmap identity is the **slug**; instructor identity is a slug-like string (`omar-haddad`); lesson ids are globally unique strings (seed: `<course-slug>-s1-l1`). Server-generated ids may be any unique string (cuid/uuid/nanoid); do not make them numeric.

### 2.3 Errors

Every error response:

```json
{ "error": { "code": "notFound", "message": "Course not found", "details": [] } }
```

`code` is **what the frontend switches on** (it constructs `new ApiError(code)`), so use exactly these strings:

| code | HTTP | When |
| --- | --- | --- |
| `invalidCredentials` | 401 | Wrong email/password, or wrong current password on change |
| `unauthenticated` | 401 | No/expired session |
| `banned` | 403 | Account is banned (login, or the session check) |
| `gone` | 401 | Account was deleted since sign-in (session check) |
| `forbidden` | 403 | Role/ownership check failed |
| `notFound` | 404 | Entity missing, **or not visible to this viewer** (drafts, deleted) |
| `emailTaken` | 409 | Register with an existing email |
| `conflict` | 409 | Audit revert found newer changes and `force` was not set |
| `cardInvalid` | 422 | Checkout card fails validation |
| `cardDeclined` | 402 | Checkout with the decline test number |
| `invalid` | 422 | Any other business-rule failure (e.g. refund an already refunded order) |
| `validation` | 422 | Zod body/query failure; put Zod issues in `details` (`{ path, message }[]`) |
| `idempotencyKeyReuse` | 422 | An `Idempotency-Key` was reused with a different request body or path (§2.6) |
| `requestInProgress` | 409 | A request with the same `Idempotency-Key` is still being processed (§2.6) |

### 2.4 "Acting as"

An admin can impersonate another user. Server-side model:

- Session has `userId` (the **real** user) and optional `actingAsUserId`.
- `effectiveUser = actingAsUserId ?? userId`; `realUser = userId`.
- All **student/instructor** endpoints operate on `effectiveUser`. All **admin** endpoints require `realUser.role === "admin"` (so an admin who is acting as a student can still use `/admin/*`).
- `POST /admin/act-as` / `POST /admin/act-as/exit` set/clear `actingAsUserId`.
- Audited actions record `actor = realUser` and `actingAs = effectiveUser` when different (§8).
- Impersonating another admin is allowed; the target's role must be one of the three.
- If the target is later deleted or banned, the next `GET /auth/me` clears `actingAsUserId` and returns the real admin as `user` with `realUser: null`.

### 2.5 Visibility rules (apply to every read)

A course is **public** when `status = "published"` and `deletedAt IS NULL`. A non-public, non-deleted course may still be read by: an admin (real or acting), the owning instructor (`user.instructorId === course.instructorId`), and any learner enrolled in it. Everyone else gets `notFound`. Soft-deleted courses are excluded from every list except the admin "deleted" view, but **enrolled learners keep access** to a soft-deleted course in the player (`GET /courses/:slug` still resolves for them).

### 2.6 Idempotency keys (required work)

Network retries, double-clicks, two open tabs and flaky connections make clients send the same request more than once. For requests that **create something or move money**, the server must make a repeat harmless. The mechanism is the standard `Idempotency-Key` request header.

**Client contract.** The frontend generates one random key (a UUID) per *user intention* (one checkout attempt, one quiz run, one "create course" action) and sends it as `Idempotency-Key: <uuid>`. A retry of the same intention re-sends the **same** key; a genuinely new action gets a new key. (The frontend half is described in `CONNECT_BACKEND.md` §6a; the mock has no keys today, so the frontend work is still to do. See §12 for the reminder this session must give the user.)

**Server behaviour** (implement as middleware, applied to the endpoints below):

1. Scope keys per user: the unique identity is `(user_id, key)`. Never share keys across users.
2. First time a key is seen: store a row `{ user_id, key, method, path, request_hash, status: "in_progress", created_at, expires_at }` **before** running the handler, using a unique constraint so concurrent requests race safely. `request_hash` = SHA-256 of the canonical request body (sorted keys).
3. When the handler finishes, save `status: "completed"`, the HTTP status and the response body. **Only store the outcome of requests that were processed; do not store transient failures (5xx)** so a retry can run again.
4. Same key arrives again:
   - `completed` and same `method + path + request_hash` → **replay**: return the stored status and body without running the handler again. Add a response header `Idempotent-Replay: true`.
   - same key but a different `request_hash` or path → `422 idempotencyKeyReuse`.
   - still `in_progress` → `409 requestInProgress` (the client may retry after a short delay).
5. Keep records for **24 hours** (`expires_at`), then purge with a scheduled job.
6. The business transaction and the key's `completed` update must commit **together** (same DB transaction), otherwise a crash between them can charge twice or lose the result.

**Where it applies:**

| Endpoint | Key | Why |
| --- | --- | --- |
| `POST /me/orders` (checkout) | **required** (`400 validation` if missing) | A duplicate means a double order and, with a real gateway, a double charge. With Stripe also pass the key through as Stripe's own idempotency key |
| `POST /courses/:slug/quiz-attempts` | honoured, optional | A duplicate creates a second attempt and awards XP twice |
| `PUT /me/progress` | honoured, optional | `watchedSec` is **additive** to the day's activity, so a retried save would double-count watch time. (Alternative: replace `watchedSec` with a cumulative counter the client sends) |
| `POST /instructor/courses` | honoured, optional | A repeat would create a second course (`title-2`) |
| `POST /me/notes`, `POST …/qa`, `POST /qa/:threadId/replies` | honoured, optional | Duplicate notes/questions/replies |
| `POST /admin/orders/:orderId/refund` | honoured, optional | Already rejected by state (`invalid`), but a replayed key should return the original success |
| `POST /contact`, `POST /newsletter` | honoured, optional | Avoid duplicate messages |

**Naturally idempotent operations need no key but must stay idempotent by state**: enrolling in a course the user already has, completing an already completed lesson, wishlist add/remove, review upsert (XP only on the first review), profile/settings updates, ban/unban to the current state, revert of an already reverted audit entry (`invalid`).

Tests to write: same key + same body twice returns the same response and creates one record; same key + different body is rejected; two concurrent requests with one key create one record; an expired key can be reused; a key from user A cannot replay user B's response.

---

## 3. Data model (relational)

The frontend treats one learner's data as a single `UserData` object (Appendix A, `learning.ts`). Return exactly that shape from `GET /me/learning` (§6) but store it normalised:

```
users            id, name, email (unique, lower-case), password_hash, role, instructor_id (nullable, FK),
                 created_at, banned_at, deleted_at
instructors      id (slug), name_en, name_ar, headline_en/ar, bio_en/ar, rating, students, courses, deleted_at
categories       slug, name_en/ar, description_en/ar, icon, deleted_at
courses          id, slug (unique), title/subtitle/description (en+ar), category_slug, instructor_id, level,
                 language, price_cents, original_price_cents, rating, rating_count, students, duration_sec,
                 updated_at (date), thumbnail, preview_video (json VideoSource), outcomes (json Localized[]),
                 requirements (json Localized[]), tags (text[]), credit_channel, featured, bestseller,
                 status, deleted_at, quiz (json QuizQuestion[] | null)
sections         id, course_id, position, title_en/ar
lessons          id, section_id, position, title_en/ar, duration_sec, video (json VideoSource), preview, thumbnail
reviews          id, course_id, user_id (nullable for seed/legacy), author_en/ar, rating 1-5, comment_en/ar,
                 date, hidden_at   -- one review per (user, course); learner reviews update in place
roadmaps         slug, title_en/ar, description_en/ar, level, icon;  roadmap_courses(roadmap_slug, position, course_slug)
testimonials     id, name_en/ar, role_en/ar, quote_en/ar
quiz_bank        category_slug, question id, q_en/ar, options (json Localized[4]), answer 0-3
coupons          code (upper-case unique), percent 1-100, active, deleted_at

enrollments      user_id, course_slug, enrolled_at                        (PK user_id+course_slug)
lesson_progress  user_id, lesson_id, completed, position_sec, completed_at
last_lesson      user_id, course_slug, lesson_id
notes            id, user_id, course_slug, lesson_id, at_sec, text, created_at
wishlist         user_id, course_slug
orders           id ("KW-…"), user_id, created_at, subtotal, discount, total, coupon, card_brand, card_last4, status
order_items      order_id, course_slug, title_en/ar (snapshot), price (snapshot)
xp_events        id, user_id, type, amount, at, ref_id
quiz_attempts    id, user_id, course_slug, score, total, passed, at, duration_sec, answers (int[])
badges_awarded   user_id, badge_id, awarded_at
notifications    id, user_id, kind, title_en/ar, body_en/ar, at, read
certificates     id, user_id, course_slug, issued_at
activity_days    user_id, day (YYYY-MM-DD), seconds
user_settings    user_id, weekly_goal, email_notifications, product_updates, autoplay_next, bio
qa_threads       id, course_slug, lesson_id, author (name), text, at, resolved
qa_replies       id, thread_id, author, role, text, at
assets           id, owner_user_id, kind ("video"), mime_type, size_bytes, storage_key, duration_sec, created_at
audit_log        id, at, actor_id, actor_name, acting_as_id, acting_as_name, action, entity, summary,
                 table_name, entity_key, before (json), after (json), reverted_by, revert_of
sessions         sid, user_id, acting_as_user_id, created_at, expires_at
```

Notes:

- Snapshot titles and prices into `order_items` so old receipts never change when a course is edited.
- `instructors.rating/students/courses` and `courses.rating/rating_count/students` are denormalised counters; recompute them when reviews/enrollments/courses change (the seed values are initial; the frontend test requires `instructors.courses` to equal the number of that instructor's courses).
- Display name on a learner review (`author`) is read from the user's *current* `users.name`, as the frontend does.
- `quiz_bank` is keyed by category; a course with its own `quiz` uses that instead.

---

## 4. Seed data

`docs/seed/*.json` (generated by `npx tsx scripts/export-seed.ts` in the frontend repo) is the exact catalog the frontend ships with:

| File | Rows | Notes |
| --- | --- | --- |
| `categories.json` | 8 | |
| `instructors.json` | 12 | |
| `courses.json` | 26 | each: 3 sections × 3 lessons, YouTube-range videos |
| `reviews.json` | 104 | `courseId` references `Course.id` |
| `roadmaps.json` | 6 | `courses` = ordered slugs |
| `testimonials.json` | 3 | |
| `quizzes.json` | 8 categories × 4 questions | |
| `demo-users.json` | 3 | all with password `demo1234` |
| `qa.json` | 26 | one seeded thread per course |

Write a seed script that loads these. Coupons to seed: `WAVE10` (10%, active), `STUDENT20` (20%, active).

**Demo accounts (password `demo1234`):**

| id | name | email | role | instructorId |
| --- | --- | --- | --- | --- |
| `u-student` | Amira Student | student@knowledgewave.dev | student | |
| `u-instructor` | Omar Haddad | instructor@knowledgewave.dev | instructor | `omar-haddad` |
| `u-admin` | Admin | admin@knowledgewave.dev | admin | |

The frontend login page has one-click buttons for these, and the Playwright suite signs in as them. In **development** seeds, also give `u-student` the same history the mock gives it (`src/lib/learning/seed.ts`: enrolled in `ui-ux-design-figma` (finished, certificate, quiz 100%, 5★ review), `javascript-complete-guide` (4 lessons done), `python-for-beginners` (2 done), wishlist `seo-for-beginners` and `machine-learning-for-everybody`, a 12-day activity streak). It is optional but the student dashboard looks empty without it.

---

## 5. Public & auth endpoints

All types below are defined in Appendix A unless shown inline.

### 5.1 Catalog (no auth required; apply visibility rules from §2.5)

| Method & path | Request | Response |
| --- | --- | --- |
| `GET /courses` | query = `CourseQuery`: `q`, `category` (comma list), `level` (comma list), `language` (comma list), `price` (`free`\|`paid`), `minRating`, `sort` (`popular`\|`rating`\|`newest`\|`price-asc`\|`price-desc`; default `popular`), `page` (default 1), `pageSize` (default 9) | `CourseListResult` |
| `GET /courses/:slug` | | `Course` or `notFound` |
| `GET /courses/by-slugs?slugs=a,b,c` | | `Course[]` in the requested order; silently omit slugs the caller may not see |
| `GET /courses/recommended` | `viewedCategories` (comma list), `excludeSlugs` (comma list), `limit` (default 4) | `Course[]` |
| `GET /courses/:slug/related?limit=3` | | `Course[]` (same category, excluding itself, public only) |
| `GET /courses/:slug/reviews` | | `Review[]` (hidden ones excluded; includes learner-written reviews) |
| `GET /categories` | | `Category[]` (non-deleted) |
| `GET /instructors` | | `Instructor[]` (non-deleted) |
| `GET /instructors/:id` | | `{ instructor: Instructor, courses: Course[] }` (courses = public only) |
| `GET /roadmaps` | | `Roadmap[]` |
| `GET /roadmaps/:slug` | | `{ roadmap: Roadmap, courses: Course[] }` (courses in roadmap order, public only) |
| `GET /testimonials` | | `Testimonial[]` |
| `GET /search?q=…&limit=5` | | `{ courses: Course[], categories: Category[], instructors: Instructor[] }` |

```ts
type CourseListResult = {
  items: Course[];
  total: number;       // after filtering
  page: number;        // clamped to [1, pageCount]
  pageCount: number;   // max(1, ceil(total / pageSize))
  facets: { category: Record<string, number>; level: Record<string, number> };
};
```

**Query semantics (must match `src/lib/catalog.ts`):**

- Text `q`: normalise both sides, then substring match on `title.en + title.ar + tags`. **Normalisation** (`src/lib/search.ts`): lower-case; remove Arabic diacritics (U+064B–U+065F, U+0670, tatweel U+0640); unify `أ إ آ ٱ → ا`, `ى → ي`, `ة → ه`; replace every non-letter/non-digit/non-space with a space; collapse whitespace; trim. (So "احمد" matches "أحمد".)
- `category`, `level`, `language`: match any of the listed values. `price=free` → `price == 0`; `paid` → `price > 0`. `minRating`: `rating >= minRating`.
- Sorts: `popular` = students desc; `rating` = rating desc then ratingCount desc; `newest` = updatedAt desc; `price-asc`/`price-desc`.
- **Facet counts ignore their own filter**: the `category` facet counts courses matching all *other* filters; same for `level`. This lets the UI show alternatives.
- `/search`: tokenise the normalised query; **every token must appear** in the haystack; score +3 per token that starts a word, +1 otherwise; rank by score; at most `limit` of each kind. Haystacks: course title (en+ar) and tags; category name; instructor name and headline.
- Recommendation score = `5 × weight(category) + rating + (bestseller ? 0.6 : 0) + log10(students)/3`, where `weight` counts occurrences in `viewedCategories` (+0.01 × index as a recency tie-break); exclude `excludeSlugs`; sort desc; take `limit`. Public courses only.

### 5.2 Auth

| Method & path | Body | Response / effects |
| --- | --- | --- |
| `POST /auth/login` | `LoginInput` `{ email, password }` | `User`. Sets session cookie. Errors: `invalidCredentials`, `banned`. Ignore deleted accounts (treat as not found). Case-insensitive email. |
| `POST /auth/register` | `RegisterInput` `{ name, email, password, role }` (`role` is `student` or `instructor`; password ≥ 8) | `User` (201), signs the user in. `emailTaken`. If `role = instructor`, **also create a public instructor profile**: `id = uniqueSlug(name)` (fallback `instructor`, suffix `-2`, `-3`… if taken), `headline {en:"Instructor", ar:"مدرّب"}`, `bio {en:"Instructor on KnowledgeWave.", ar:"مدرّب على KnowledgeWave."}`, rating/students/courses 0, and set `user.instructorId` |
| `POST /auth/logout` | | 204. Destroys the session, clears cookies |
| `GET /auth/me` | | `{ status: "ok", user: User, realUser: User \| null }`, **or** an error: `401 unauthenticated` (no session), `401 gone` (account deleted), `403 banned` (and destroy the session). `realUser` is non-null only while acting-as. The frontend calls this **once per page load** (`SessionGuard`), so role/name changes and bans take effect on the next page load |
| `POST /auth/forgot-password` | `{ email }` | 204 always (never reveal whether the email exists). Send a reset email if it exists |
| `POST /auth/change-password` | `{ current, next }` (`next` ≥ 8) | 204. `invalidCredentials` if `current` is wrong |
| `POST /contact` | `ContactInput` `{ name, email, message }` (message ≥ 10) | 204. Optional; the frontend's contact and newsletter forms currently send nothing |
| `POST /newsletter` | `{ email }` | 204. Optional |

`toUser(account)` (what `User` contains): `{ id, name, email, role, instructorId? }`. **Never return `password`, `bannedAt` or `deletedAt` in `User`.**

---

## 6. Student endpoints (`/me`, operate on the effective user)

### 6.1 The learner record

`GET /me/learning` → `UserData` (Appendix A). The whole record in one call; nearly every student page reads it (`useUserData`). Shape:

```ts
type UserData = {
  enrollments: { slug: string; at: string }[];
  progress: Record<lessonId, { completed: boolean; positionSec: number; completedAt?: string }>;
  lastLesson: Record<courseSlug, lessonId>;
  notes: Note[];
  wishlist: string[];                       // course slugs
  orders: Order[];                          // newest first
  reviews: Record<courseSlug, { rating: 1-5; comment: string; date: string }>;
  quizAttempts: QuizAttempt[];              // newest first
  xpEvents: XpEvent[];
  badges: Record<badgeId, awardedAtISO>;
  notifications: Notification[];            // newest first
  certificates: Certificate[];
  activity: Record<"YYYY-MM-DD", seconds>;
  settings: { weeklyGoal; emailNotifications; productUpdates; autoplayNext };
  bio: string;
};
```

A learner with no activity returns the empty record: all arrays/objects empty, `settings = { weeklyGoal: 5, emailNotifications: true, productUpdates: false, autoplayNext: true }`, `bio = ""`.

*(Later optimisation, only after the frontend is connected: split into several endpoints. The first version must return this single object so no component changes.)*

### 6.2 Actions

Most actions return **`Effects`** so the UI can show toasts:

```ts
type Effects = {
  xpGained: number;          // total XP change caused by this action
  levelUp?: number;          // new level, if it increased
  newBadges: string[];       // badge ids unlocked by this action
  certificateId?: string;    // lesson completion that finished a course
  courseCompleted?: string;  // that course's slug
};
```

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /me/enrollments` | `{ slugs: string[] }` | `Effects`. **Only free courses (price 0)** unless the caller is an admin/acting admin; paid courses are enrolled by checkout. Idempotent per slug. Removes the slug from the wishlist; adds notification `course` |
| `POST /me/lessons/:lessonId/complete` | `{ courseSlug }` | `Effects` with `certificateId?`, `courseCompleted?`. Idempotent (already completed → no change). Must be enrolled |
| `PUT /me/progress` | `{ courseSlug, lessonId, positionSec, watchedSec, day }` | 204. Resume position + watch time. See rules below. Called every ~10 s while watching |
| `POST /me/notes` | `{ courseSlug, lessonId, atSec, text }` | `Note` (also acceptable: `Effects`; the UI only refetches `/me/learning`) |
| `DELETE /me/notes/:id` | | 204 |
| `PUT /me/wishlist/:slug` / `DELETE /me/wishlist/:slug` | | 204 (the frontend function is a toggle; the adapter picks the verb from current state) |
| `POST /me/notifications/read` | `{ ids?: string[] }` | 204. No `ids` = mark all read |
| `PUT /me/reviews/:slug` | `ReviewInput` `{ rating 1-5, comment ≤ 400 }` | `Effects`. Must be enrolled (recommended: course completed). Creates or **replaces** the learner's review; **XP only on the first review of that course** |
| `PATCH /me/profile` | `ProfileInput` `{ name ≥ 2, bio ≤ 240, weeklyGoal 1-30 }` | `User` (updated name). Name is stored on the user; bio and weeklyGoal on settings |
| `PATCH /me/settings` | `Partial<Settings>` | `Settings` |
| `GET /courses/:slug/quiz` | | `{ questions: PublicQuizQuestion[] }` where `PublicQuizQuestion = Omit<QuizQuestion, "answer">` (id, `q`, 4 `options`) **without the answers**. Questions = the course's own `quiz` if it has one, else the category bank. Must be enrolled **and** have completed every lesson (else `forbidden`). The mock currently sends full questions to the browser; the real API must not leak answers |
| `POST /courses/:slug/quiz-attempts` | `{ answers: number[], durationSec }` | `{ effects: Effects, attempt: QuizAttempt, result: { score, total, passed, perfect, correct: number[] } }`. Server loads the questions the same way and **grades itself**. Same eligibility as above. `answers[i] = -1` for unanswered. `result.correct[i]` is the correct option index of question *i*, returned **after** grading so the result screen can show the review (the frontend needs one small change for this, see `CONNECT_BACKEND.md`) |
| `POST /me/orders` | `{ slugs: string[], card: CheckoutInput, coupon?: string }` | `{ order: Order, effects: Effects }`. See §6.4 |
| `POST /coupons/validate` | `{ code }` | `{ code, percent }` or `404 notFound` if unknown/inactive/deleted. (Used by the cart; the frontend currently reads the coupon table directly) |
| `GET /me/leaderboard` | | `LeaderboardEntry[]`: `{ id, name: Localized, xp, me: boolean, rank }`. Weekly XP (since Monday 00:00 of the current week) of the top N learners **plus the caller**, ranked. The mock uses 7 fake peers |
| `GET /courses/:slug/lessons/:lessonId/qa` | | `QaThread[]`, newest first. Caller must be enrolled, the owning instructor, or admin |
| `POST /courses/:slug/lessons/:lessonId/qa` | `{ text }` | `QaThread` (author = caller's name, `replies: []`) |
| `POST /qa/:threadId/replies` | `{ text }` | `QaReply` (`role` = caller's role; author = name). Allowed: enrolled learners, the course's instructor, admins |

Rules for `PUT /me/progress` (`savePosition`): upsert `lesson_progress`; if the lesson is already completed, store `positionSec = 0`; else `positionSec = floor(max(0, positionSec))`; set `lastLesson[courseSlug] = lessonId`; if `watchedSec > 0` add `min(watchedSec, 120)` seconds to `activity[day]`. Validate the day format.

### 6.3 Gamification rules (must be reproduced exactly)

**XP awards** (`src/lib/learning/gamification.ts`):

| Event | XP | `xp_events.type` | refId |
| --- | --- | --- | --- |
| Complete a lesson (first time) | 20 | `lesson` | lessonId |
| Complete the last lesson of a course (first time) | 150 extra | `course` | course slug |
| Pass a quiz for the first time | 50 | `quiz` | attemptId |
| …and score 100% on that first pass | +25 | (same event, 75 total) | |
| Any other quiz attempt (retake, fail) | 5 | `quiz` | attemptId |
| First review of a course | 15 | `review` | course slug |

**Levels:** level *n* begins at `50·n·(n−1)` XP (0, 100, 300, 600, 1000, 1500…). `level = max(1, floor((1 + sqrt(1 + xp/12.5)) / 2))`.

**Quiz grading:** `passed = score/total ≥ 0.7`; `perfect = score == total`; an unanswered question counts wrong. "First pass" = the learner has no earlier attempt with `passed = true` for that course.

**Streak days:** a day counts as active if `activity[day] ≥ 30` seconds **or** any XP event happened that (local) day. `current` streak counts back from today, or from yesterday if today is not yet active. `best` = longest run ever. (The frontend computes streak/level display itself from `UserData`; the backend needs them only for badge tests.)

**Badges** (id → condition), awarded at most once, in `badges` with timestamp:

| id | Name (EN) | Condition |
| --- | --- | --- |
| `first-lesson` | First step | ≥ 1 lesson completed |
| `first-course` | Graduate | ≥ 1 certificate |
| `streak-3` | On a roll | best streak ≥ 3 |
| `streak-7` | Unstoppable | best streak ≥ 7 |
| `quiz-ace` | Quiz ace | any attempt with score == total |
| `reviewer` | Helpful reviewer | ≥ 1 review |
| `collector` | Curious mind | ≥ 3 enrollments |
| `marathon` | Marathoner | ≥ 10 lessons completed |
| `level-5` | Level 5 | level ≥ 5 |

Arabic names/descriptions for badges live in the frontend (`BADGES`); the backend only stores ids.

**Settle step** (run after *every* action that can change XP/progress): compute stats; for each badge whose condition is newly true and not yet awarded, store it and create notification `badge` (title `{en:"Badge unlocked", ar:"تم فتح وسام جديد"}`, body `{en:"You earned “<badge en>”.", ar:"حصلت على «<badge ar>»."}`); if the level increased, create notification `xp` (title `{en:"Level N reached!", ar:"وصلت إلى المستوى N!"}`, body `{en:"Keep going, you are on a roll.", ar:"واصل التقدم، أنت في تقدم رائع."}`). `Effects.xpGained` = total XP after − before; `levelUp` = new level if higher; `newBadges` = ids unlocked now.

**Other notifications created by actions** (kind → title / body, EN and AR):

| kind | When | title en / ar | body en / ar |
| --- | --- | --- | --- |
| `course` | enrolled in a course | "You are enrolled!" / "تم تسجيلك في الدورة!" | "Start learning “{title en}”." / "ابدأ تعلّم «{title ar}»." |
| `certificate` | course completed | "Certificate ready" / "الشهادة جاهزة" | "You completed “{title en}”." / "أتممت دورة «{title ar}»." |
| `order` | order placed | "Order confirmed" / "تم تأكيد الطلب" | "Order {id} is complete." / "تم إكمال الطلب {id}." |

**Completing a lesson** (`completeLesson`): ignore if already completed or the lesson is not in the course; mark completed (`positionSec = 0`, `completedAt = now`); award 20 XP; set `lastLesson` to the next lesson if there is one; if **every** lesson of the course is now completed and no certificate exists for it: create certificate (`id` = unique upper-case string), award 150 XP (`course`), notify `certificate`. Return `certificateId` and `courseCompleted = slug` in that case.

**Resume logic** (display only, in the frontend): resume at `lastLesson[slug]` if it exists in the course and is not completed; otherwise the first incomplete lesson.

### 6.4 Checkout (`POST /me/orders`)

`card` is `CheckoutInput`: `{ name ≥ 2, email, number, expiry "MM/YY", cvc 3-4 digits }`.

Server steps, in one DB transaction:

1. Validate the body (`cardInvalid` if the card fails Luhn (13–19 digits) / expiry (valid through the end of the month) / CVC).
2. **Decline the test number `4000000000000002`** with `cardDeclined` (402). The success test card is `4242 4242 4242 4242`. No real gateway: otherwise payment "succeeds". (If a real gateway is added later, card data goes to the gateway directly and the backend never receives it.)
3. Load the courses by slug (`notFound` if any is missing or not visible); **recompute** subtotal from current prices (never trust the client), apply the coupon if it is active and not deleted (percent of the subtotal; `discount = round(subtotal × percent) / 100`; total = subtotal − discount; all rounded to cents).
4. Create the `Order`: `id = "KW-" + <base36 time-based>`, `createdAt`, `items` (slug + title snapshot + price snapshot), `subtotal`, `discount`, `total`, `coupon` (code or omitted), `cardBrand` (`visa` starts with 4; `mastercard` 51–55 or 22–27; `amex` 34/37; else `other`), `cardLast4`, `status: "paid"`.
5. Enroll the learner in every course (skips existing; removes from wishlist; `course` notifications), add the `order` notification, run **settle**. Return `{ order, effects }`.

Never store the full card number or CVC. Free carts (total 0) do not call this endpoint: the frontend uses `POST /me/enrollments` (which must therefore accept free courses).

Refunds are admin-only (§8).

---

## 7. Instructor endpoints (`/instructor`, effective user must be `instructor`, or admin)

Ownership rule (`canManage`): admins manage any course; an instructor only courses where `course.instructorId === user.instructorId`; else `forbidden`.

| Method & path | Body / query | Response |
| --- | --- | --- |
| `GET /instructor/courses` | | `Course[]` — own non-deleted courses, all statuses |
| `GET /instructor/courses/:slug` | | `Course` (for editing; owner/admin only) |
| `POST /instructor/courses` | `Draft` | `Course` (201) — creates |
| `PUT /instructor/courses/:slug` | `Draft` | `Course` — updates |
| `PATCH /instructor/courses/:slug/status` | `{ status: "draft"\|"published"\|"archived" }` | `Course` (also sets `updatedAt` to today) |
| `DELETE /instructor/courses/:slug` | | 204 — **soft delete** (`deletedAt = now`) |
| `GET /instructor/dashboard` | | `DashboardData` |
| `GET /instructor/students` | | `(StudentRow & { courseTitle })[]` |
| `GET /instructor/questions` | | threads of own courses + `courseTitle`, `lessonTitle?`, newest first |
| `POST /instructor/questions/:threadId/replies` | `{ text }` | `QaReply` (role `instructor`/`admin`) |
| `PATCH /instructor/questions/:threadId` | `{ resolved: boolean }` | 204 |
| `GET /instructor/courses/:slug/analytics` | | `CourseAnalytics` |

### 7.1 The `Draft` body and server-side conversion

The course builder submits a **`Draft`** (Appendix B); the server converts it to a stored `Course` with the exact rules of `draftToCourse` in `src/lib/builder/draft.ts`, then validates with `CourseSchema`. Port those rules:

1. **Validation** (`validateDraft`). *Draft level* (any save): title in at least one language; a category; at least one lesson in total; every lesson has a title (either language), a valid video (`youtube`: id matches `^[\w-]{11}$`; `upload`: non-empty `assetId`) and `durationSec > 0`; every quiz question has text and all 4 options in at least one language and `answer ∈ 0..3`; `price ≥ 0`; `originalPrice ≥ price` when set. *Publish level* (`status = "published"`): additionally description ≥ 20 characters in either language, a subtitle, ≥ 1 learning outcome, every non-empty section titled. Return `validation` errors with `details` listing `{ step, key }` pairs (the UI shows them in steps `basics`, `curriculum`, `quiz`, `pricing`).
2. **Bilingual mirroring**: if only one language of a `Localized` is filled, copy it to the other.
3. Drop sections with no lessons; an empty section title becomes `Section N` / `القسم N`; lesson durations round to ≥ 1 s.
4. Guarantee a free preview: if no lesson has `preview = true`, set it on the first lesson.
5. `durationSec` = sum of lesson durations.
6. `thumbnail` = draft thumbnail, else the first lesson's YouTube thumbnail (`https://img.youtube.com/vi/<id>/hqdefault.jpg`), else its uploaded poster, else a generated placeholder.
7. `previewVideo` = the first lesson's video; for YouTube it is capped at 180 s after `start` (`end = min(end, start+180)` or `start+180`).
8. Keep `rating`, `ratingCount`, `students`, `featured`, `bestseller` from the existing course when editing; new courses start at 0/false.
9. `credit.channel` = the instructor's display name; `updatedAt` = today; `id = "c-" + slug`.
10. **Slug** for new courses: `slugify(title.en || title.ar)` — NFKD, strip diacritics, lower-case, non-alphanumerics → `-`, trim `-`, max 60 chars; fallback `course` for Arabic-only titles; if taken append `-2`, `-3`…. The slug never changes after creation.
11. `quiz` is `undefined` when empty (learners then get the category bank).

### 7.2 Response types

```ts
type DashboardData = {
  courses: Course[];
  totals: { students: number; revenue30: number; rating: number; published: number; drafts: number };
  series: { day: string /* YYYY-MM-DD */; date: string /* ISO */; enrollments: number; revenue: number }[]; // last 30 days, oldest first
  top: { course: Course; students: number; revenue30: number }[];   // top 5 by 30-day revenue
  recentReviews: (Review & { courseTitle: Localized; slug: string })[]; // 5 newest, visible only
  openQuestions: number;   // threads of own courses with no instructor/admin reply and not resolved
};

type StudentRow = { id: string; name: string; email: string; course: string /*slug*/; progress: number /*0-100*/;
                    lastActive: string /*YYYY-MM-DD*/; real: boolean };      // + courseTitle: Localized

type CourseAnalytics = {
  course: Course;
  series: { day; date; enrollments; revenue }[];                    // 90 days
  completion: { lessonId: string; percent: number; title: Localized }[];  // share of enrolled learners who completed each lesson
  ratings: { stars: 5|4|3|2|1; count: number }[];
  students: number;
};
```

With real data: `revenue` = sum of paid order-item prices per day × (1 − 0.15 platform fee), `enrollments` = enrollments per day, `completion` = completed/enrolled per lesson, `ratings` = review counts, `totals.rating` = rating average weighted by rating count, `students` = distinct enrolled learners. **Drop the `real: false` demo rows**; keep the `real` field (always `true`). The mock blends demo numbers with real ones for presentation; the backend serves real numbers only. (`progress` for a student row = `courseProgress(course, data).percent`: completed lessons / total lessons.)

---

## 8. Admin endpoints (`/admin`, requires **real** user role `admin`)

Every handler first checks `realUser.role === "admin"` (not the effective user). All **changes** below are audited (§8.1).

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /admin/overview` | | `AdminOverview` |
| `GET /admin/users` | | `UserRow[]` = `Account` (without password) + `enrollments` count + `certificates` count, sorted by `createdAt` asc, **including banned and deleted** |
| `PATCH /admin/users/:id` | `{ name, email, role }` | 204. Cannot change *own* role away from admin (`forbidden`). Promoting to instructor without an `instructorId` creates the instructor profile (audited as its own `create`) |
| `POST /admin/users/:id/ban` / `/unban` | | 204. Cannot ban self (`forbidden`). Sets/clears `bannedAt`; audit action `ban`/`unban`. Active sessions of a banned user are rejected on the next `/auth/me` |
| `POST /admin/users/:id/reset-password` | | 204 (mock sets `demo1234`; real: generate a one-time password or send a reset email) |
| `DELETE /admin/users/:id` / `POST /admin/users/:id/restore` | | 204. Soft delete (`deletedAt`); cannot delete self |
| `GET /admin/users/:id/learning` | | `{ data: UserData, enrollments: { slug, at, course?: Course, progress: number }[], orders: Order[] }` |
| `POST /admin/users/:id/enrollments` | `{ slug }` | 204 (enrol incl. paid courses) |
| `DELETE /admin/users/:id/enrollments/:slug` | | 204 |
| `POST /admin/users/:id/enrollments/:slug/reset-progress` | | 204: removes that course's lesson progress, `lastLesson`, certificates, quiz attempts and notes |
| `GET /admin/orders` | | `(Order & { userId, userName })[]` newest first |
| `POST /admin/orders/:orderId/refund` | `{ userId }` | 204. `invalid` if not found/already refunded. Sets `status = "refunded"` and removes the enrollments the order granted **unless** another paid order of that user still contains the course. Audit action `refund` |
| `GET /admin/reviews` | | `(Review & { slug: string; hidden: boolean })[]` all, including hidden |
| `POST /admin/reviews/:id/hide` / `/restore` | | 204 (`hidden_at`) |
| `GET /admin/courses` | | `Course[]` including drafts, archived **and soft-deleted** |
| `PATCH /admin/courses/:slug/featured` | `{ featured }` | 204 |
| `POST /admin/courses/:slug/restore` | | 204 (clears `deletedAt`) |
| *(course create/edit/status/delete)* | | Reuse the instructor endpoints (admins pass `canManage`). The admin builder also lets an admin choose `draft.instructorId` |
| `GET /admin/categories` | | `Category[]` including deleted |
| `POST /admin/categories` | `Category` (without `deletedAt`) | 204; `invalid` if the slug exists |
| `PUT /admin/categories/:slug` | `Category` | 204 |
| `DELETE /admin/categories/:slug` / `POST …/restore` | | 204 (soft) |
| `GET /admin/coupons` | | `Coupon[]` including deleted |
| `POST /admin/coupons` | `Coupon` | 204; code upper-cased/trimmed; `invalid` if exists |
| `PUT /admin/coupons/:code` | `Coupon` | 204 |
| `DELETE /admin/coupons/:code` / `POST …/restore` | | 204 (soft) |
| `GET /admin/audit` | | `AuditEntry[]` newest first |
| `POST /admin/audit/:id/revert` | `{ force?: boolean }` | `AuditEntry` (the new revert entry). `conflict` (409) if the target changed since and `force` is false |
| `DELETE /admin/qa/:threadId` | | 204 |
| `POST /admin/act-as` | `{ userId }` | `User` (the target). Session `actingAsUserId = userId` |
| `POST /admin/act-as/exit` | | `User` (the real admin) |

```ts
type AdminOverview = {
  users: number; students: number; instructors: number;      // non-deleted accounts
  courses: number; published: number; drafts: number;          // non-deleted courses
  enrollments: number;                                         // total enrollment rows
  revenue30: number;                                           // sum of the 30-day series (gross, rounded)
  orders: number;
  series: { day; date; enrollments; revenue }[];               // 30 days, platform-wide
  recent: AuditEntry[];                                        // 6 newest
};
```

### 8.1 Audit log semantics (important)

Every admin mutation is recorded as "set **table[key]** to a new value", with the full `before` and `after` snapshots (JSON). `AuditEntry` fields: `id, at, actorId, actorName, actingAs?{id,name}, action, entity, summary, table, key, before, after, revertedBy?, revertOf?`.

- `action` ∈ `create | update | delete | restore | revert | refund | ban | unban`. `entity` is a human noun (`course`, `account`, `category`, `coupon`, `review`, `instructor profile`, `learner data`). `summary` is an English sentence (e.g. `Banned Amira Student`, `Set “React from Scratch” to draft`). `table` ∈ `courses, categories, instructors, accounts, coupons, hiddenReviews, users` (`users` = a learner's whole record).
- **Who is audited**: only changes made by a real admin (including while acting as another user — then `actingAs` is set and the summary of learner actions ends with ` (as <name>)`). Instructors editing their own courses are *not* audited.
- Learner actions performed while an admin is acting (enroll, complete lesson, note, wishlist, review, quiz, order) are audited as `update` on `table: "users"` with the whole learner record before/after.
- **Revert** (`POST /admin/audit/:id/revert`): (1) the entry must exist and not already be reverted (`invalid`); (2) read the **current** value of `table[key]`; (3) if it is not canonically equal to the entry's `after` and `force` is false → `conflict`; (4) write `before` back (`null` before ⇒ delete/hide the entity); (5) append a new entry `action: "revert"`, `revertOf: <id>`, with `before`/`after` swapped; (6) set `revertedBy` on the original. Because a revert is itself an entry, reverting a revert is **redo**.
- **Canonical equality** = compare JSON with object keys sorted recursively, ignoring `undefined`. Never compare serialised strings that depend on key order.
- Implementation tip: write one function `applySnapshot(table, key, value | null)` per table (courses incl. sections/lessons, accounts, etc.) and use it for both normal writes and reverts. Snapshots may be stored as JSONB in `audit_log` regardless of how the live data is normalised.

---

## 9. Uploads and video playback

The course builder lets an instructor attach an **MP4 or WebM up to 500 MB** to a lesson. Rules from the frontend (`validateVideoFile`): allowed mime types `video/mp4`, `video/webm`; size 1 byte … 524 288 000 bytes; errors `type`, `empty`, `size` (return `validation` with `details[0].message` of one of these three).

Suggested flow (the frontend's `uploadVideo(file, onProgress)` becomes this):

1. `POST /uploads/videos` `{ fileName, mimeType, sizeBytes }` → `{ assetId, uploadUrl, method: "PUT", headers }`. Validate type/size; create an `assets` row (`status: pending`). `uploadUrl` is a presigned S3/R2 URL (or, in development, `/api/v1/uploads/videos/:assetId/content`, which streams the body to disk).
2. The browser uploads the bytes with progress (XHR/fetch).
3. `POST /uploads/videos/:assetId/complete` `{ durationSec, thumbnail? }` → `{ assetId, mimeType, durationSec, thumbnail? }`. The browser reads duration and a 480×270 JPEG poster (data URL) from the file; the server should verify the object exists and (ideally) re-probe duration with ffprobe.
4. The lesson is saved with `video: { type: "upload", assetId, mimeType }`, `durationSec`, `thumbnail`.

Playback: `GET /assets/:assetId/stream` with **HTTP Range support** (`206 Partial Content`), `Content-Type` = stored mime. Authorise: the asset's owner, admins, anyone enrolled in a course containing the asset, and anyone for assets used by a **preview lesson** or a course's `previewVideo`. Alternatively return short-lived signed URLs. The frontend puts the result in a `<video src>`.

Delete the asset when its lesson/course is permanently removed (soft deletes keep it).

---

## 10. Cross-cutting requirements

- **Authorization on every route**, server-side; the frontend's role checks are UX only.
- **Transactions** for: register-as-instructor (user + profile), checkout (order + enrollments + notifications + XP), refunds, revert, enrol/unenrol.
- **Idempotency**: implement `Idempotency-Key` handling exactly as specified in §2.6 (required on checkout), and keep state-based idempotency for lesson completion, enrollment, wishlist add and review upsert.
- **Rate limiting** on login, register, forgot-password, contact. Account lockout is optional.
- **Logging** with request ids; never log passwords or card data.
- **Pagination**: only `GET /courses` is paginated; other lists return everything (small data) for now. Cap list sizes sensibly.
- **Time**: store UTC; compare "this week" using Monday 00:00 in the *learner's* timezone only for the leaderboard weekly XP (use UTC Monday if the timezone is unknown).
- **Locale**: the backend does not need the locale; every localised field is returned in both languages. (Only emails, if sent, need a language: add `locale` to the user later.)
- **Health**: `GET /health` → `{ ok: true }`.

---

## 11. Suggested build order (each step is independently testable)

1. Project skeleton, config, error format, Zod validation middleware, health route, DB + migrations.
2. Seed script from `docs/seed/*.json` + demo accounts + coupons.
3. Auth: register/login/logout/me, sessions, cookies, CSRF header, password hashing, role middleware, ban/deleted checks.
4. Public catalog: courses (query/facets/sort/paginate), course by slug (+visibility), related, recommended, reviews, categories, instructors, roadmaps, testimonials, search (+ Arabic normalisation).
5. Learner record: `GET /me/learning`, enroll (free), progress, complete lesson (+XP, certificate, badges, notifications = **settle**), notes, wishlist, notifications, reviews, profile/settings.
6. Quiz attempts and leaderboard; Q&A.
7. Coupons validate + checkout + orders, **including the idempotency-key middleware (§2.6)**. Build the middleware as a reusable component here and then attach it to the other listed endpoints as you reach them.
8. Instructor: list/get/save/status/delete (`Draft` → `Course`), dashboard/students/questions/analytics.
9. Uploads + streaming.
10. Admin: users, learning data, orders/refunds, reviews, courses, categories, coupons, **audit log + revert**, act-as.
11. Hardening: rate limits, logging, tests, docs (OpenAPI generated from the Zod schemas is a good deliverable).

**Acceptance checklist** (the frontend's own tests describe the expected behaviour; run them against the backend once connected): guests can browse; login/register/logout work with cookies; banned/deleted users are rejected on the next load; students can enrol, watch, complete, earn XP/badges/certificate, review, take the quiz after completing the course; checkout works with the test card and declines `4000000000000002`; coupons `WAVE10`/`STUDENT20` apply; instructors can create, publish, unpublish, archive, delete courses and upload video; drafts are invisible to the public; admin can ban, change roles, refund, hide reviews, edit categories/coupons, act as another user, and revert/redo any change including conflict detection; replaying a checkout request with the same `Idempotency-Key` returns the original order and creates no second order.

---

## 12. Handoff: tell the user to hand over the frontend work

**When the backend is finished, the session that built it must end its final message with a clear reminder to the user** (not only a line inside this document):

> "The backend is done. When you start the frontend-connection session, tell it to implement the **client side of idempotency keys** from `docs/CONNECT_BACKEND.md` §6a. The frontend does not send `Idempotency-Key` headers yet, so checkout, quiz submission, progress saves and course creation are not protected against duplicates until it does."

Also record in the backend's own README (or `docs/`) the exact list of endpoints that honour or require the key (§2.6), so the connection session can implement the frontend side without reading this whole file.

---

## Appendix A — Zod schemas (verbatim from `src/lib/schemas/`)

These are the request/response contracts. Copy them into the backend (`import { z } from "zod"` — Zod 4).

### `common.ts`

```ts
import { z } from "zod";

export const LocaleSchema = z.enum(["en", "ar"]);

/** Every user-facing string in the mock data is bilingual. */
export const LocalizedSchema = z.object({ en: z.string().min(1), ar: z.string().min(1) });
export type Localized = z.infer<typeof LocalizedSchema>;

/**
 * Where a lesson's video comes from.
 * - youtube: embedded via the IFrame API (optional start/end seconds to cut a long video into lessons)
 * - upload: an instructor-uploaded file; `assetId` points at the blob in the mock IndexedDB store
 *   (later: the id of a file Express/S3 serves).
 */
export const VideoSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("youtube"),
    id: z.string().length(11),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("upload"),
    assetId: z.string().min(1),
    mimeType: z.string().optional(),
  }),
]);
export type VideoSource = z.infer<typeof VideoSourceSchema>;

export const RoleSchema = z.enum(["student", "instructor", "admin"]);
export const LevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
export type Level = z.infer<typeof LevelSchema>;
```

### `course.ts`

```ts
import { z } from "zod";
import { LevelSchema, LocalizedSchema, VideoSourceSchema } from "./common";

export const CategorySchema = z.object({
  slug: z.string(),
  name: LocalizedSchema,
  description: LocalizedSchema,
  /** lucide-react icon name, resolved in the UI. */
  icon: z.string(),
  /** Soft delete: admins can restore it from the audit log. */
  deletedAt: z.string().optional(),
});
export type Category = z.infer<typeof CategorySchema>;

export const InstructorSchema = z.object({
  id: z.string(),
  name: LocalizedSchema,
  headline: LocalizedSchema,
  bio: LocalizedSchema,
  rating: z.number().min(0).max(5),
  students: z.number().int().nonnegative(),
  courses: z.number().int().nonnegative(),
  deletedAt: z.string().optional(),
});
export type Instructor = z.infer<typeof InstructorSchema>;

export const LessonSchema = z.object({
  id: z.string(),
  title: LocalizedSchema,
  durationSec: z.number().int().positive(),
  video: VideoSourceSchema,
  /** Free preview: playable on the public course page. */
  preview: z.boolean().default(false),
  /** Poster frame (data URL) captured from an uploaded video. */
  thumbnail: z.string().optional(),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const SectionSchema = z.object({
  id: z.string(),
  title: LocalizedSchema,
  lessons: z.array(LessonSchema).min(1),
});
export type Section = z.infer<typeof SectionSchema>;

export const QuizQuestionSchema = z.object({
  id: z.string(),
  q: LocalizedSchema,
  options: z.array(LocalizedSchema).length(4),
  answer: z.number().int().min(0).max(3),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const CourseStatusSchema = z.enum(["draft", "published", "archived"]);
export type CourseStatus = z.infer<typeof CourseStatusSchema>;

export const CourseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: LocalizedSchema,
  subtitle: LocalizedSchema,
  description: LocalizedSchema,
  category: z.string(),
  instructorId: z.string(),
  level: LevelSchema,
  language: z.enum(["en", "ar"]),
  price: z.number().nonnegative(),
  originalPrice: z.number().nonnegative().optional(),
  rating: z.number().min(0).max(5),
  ratingCount: z.number().int().nonnegative(),
  students: z.number().int().nonnegative(),
  durationSec: z.number().int().positive(),
  updatedAt: z.string(),
  thumbnail: z.string(),
  previewVideo: VideoSourceSchema,
  outcomes: z.array(LocalizedSchema).min(1),
  requirements: z.array(LocalizedSchema),
  tags: z.array(z.string()),
  /** Credit for the embedded YouTube content. */
  credit: z.object({ channel: z.string() }),
  featured: z.boolean().default(false),
  bestseller: z.boolean().default(false),
  sections: z.array(SectionSchema).min(1),
  /** Only published courses are visible in the catalog. */
  status: CourseStatusSchema.default("published"),
  deletedAt: z.string().optional(),
  /** Instructor-written quiz; when absent the category quiz bank is used. */
  quiz: z.array(QuizQuestionSchema).optional(),
});
export type Course = z.infer<typeof CourseSchema>;

export const ReviewSchema = z.object({
  id: z.string(),
  courseId: z.string(),
  author: LocalizedSchema,
  rating: z.number().int().min(1).max(5),
  comment: LocalizedSchema,
  date: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const RoadmapSchema = z.object({
  slug: z.string(),
  title: LocalizedSchema,
  description: LocalizedSchema,
  level: LevelSchema,
  icon: z.string(),
  /** Ordered course slugs. */
  courses: z.array(z.string()).min(2),
});
export type Roadmap = z.infer<typeof RoadmapSchema>;

export const TestimonialSchema = z.object({
  id: z.string(),
  name: LocalizedSchema,
  role: LocalizedSchema,
  quote: LocalizedSchema,
});
export type Testimonial = z.infer<typeof TestimonialSchema>;
```

### `user.ts`

```ts
import { z } from "zod";
import { RoleSchema } from "./common";

export const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.email(),
  role: RoleSchema,
  /** Links an instructor account to its public instructor profile. */
  instructorId: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const LoginSchema = z.object({
  email: z.email({ message: "invalidEmail" }),
  password: z.string().min(6, { message: "passwordShort" }),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterSchema = z.object({
  name: z.string().min(2, { message: "nameShort" }),
  email: z.email({ message: "invalidEmail" }),
  password: z.string().min(8, { message: "passwordShort8" }),
  role: z.enum(["student", "instructor"]),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const ForgotSchema = z.object({ email: z.email({ message: "invalidEmail" }) });
export type ForgotInput = z.infer<typeof ForgotSchema>;

export const ContactSchema = z.object({
  name: z.string().min(2, { message: "nameShort" }),
  email: z.email({ message: "invalidEmail" }),
  message: z.string().min(10, { message: "messageShort" }),
});
export type ContactInput = z.infer<typeof ContactSchema>;

/** Mock account registry entry (the password is stored in clear text because it is a demo). */
export const AccountSchema = UserSchema.extend({
  password: z.string(),
  createdAt: z.string(),
  bannedAt: z.string().optional(),
  deletedAt: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;
```

### `learning.ts`

```ts
import { z } from "zod";
import { LocalizedSchema } from "./common";

export const ProgressEntrySchema = z.object({
  completed: z.boolean(),
  positionSec: z.number().nonnegative(),
  completedAt: z.string().optional(),
});

export const NoteSchema = z.object({
  id: z.string(),
  courseSlug: z.string(),
  lessonId: z.string(),
  atSec: z.number().nonnegative(),
  text: z.string().min(1),
  createdAt: z.string(),
});
export type Note = z.infer<typeof NoteSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  items: z.array(z.object({ slug: z.string(), title: LocalizedSchema, price: z.number().nonnegative() })),
  subtotal: z.number().nonnegative(),
  discount: z.number().nonnegative(),
  total: z.number().nonnegative(),
  coupon: z.string().optional(),
  cardBrand: z.string(),
  cardLast4: z.string(),
  status: z.enum(["paid", "refunded"]),
});
export type Order = z.infer<typeof OrderSchema>;

export const XpEventSchema = z.object({
  id: z.string(),
  type: z.enum(["lesson", "quiz", "course", "review", "streak"]),
  amount: z.number().int(),
  at: z.string(),
  refId: z.string().optional(),
});
export type XpEvent = z.infer<typeof XpEventSchema>;

export const QuizAttemptSchema = z.object({
  id: z.string(),
  courseSlug: z.string(),
  score: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  passed: z.boolean(),
  at: z.string(),
  durationSec: z.number().nonnegative(),
  answers: z.array(z.number().int()),
});
export type QuizAttempt = z.infer<typeof QuizAttemptSchema>;

export const ReviewEntrySchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string(), date: z.string() });
export type ReviewEntry = z.infer<typeof ReviewEntrySchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  kind: z.enum(["xp", "badge", "order", "certificate", "course", "system"]),
  title: LocalizedSchema,
  body: LocalizedSchema,
  at: z.string(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const CertificateSchema = z.object({ id: z.string(), courseSlug: z.string(), issuedAt: z.string() });
export type Certificate = z.infer<typeof CertificateSchema>;

export const SettingsSchema = z.object({
  weeklyGoal: z.number().int().min(1).max(30),
  emailNotifications: z.boolean(),
  productUpdates: z.boolean(),
  autoplayNext: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Everything the mock backend stores for one learner. */
export const UserDataSchema = z.object({
  enrollments: z.array(z.object({ slug: z.string(), at: z.string() })),
  progress: z.record(z.string(), ProgressEntrySchema),
  lastLesson: z.record(z.string(), z.string()),
  notes: z.array(NoteSchema),
  wishlist: z.array(z.string()),
  orders: z.array(OrderSchema),
  reviews: z.record(z.string(), ReviewEntrySchema),
  quizAttempts: z.array(QuizAttemptSchema),
  xpEvents: z.array(XpEventSchema),
  badges: z.record(z.string(), z.string()),
  notifications: z.array(NotificationSchema),
  certificates: z.array(CertificateSchema),
  /** Seconds of learning per local day (YYYY-MM-DD). */
  activity: z.record(z.string(), z.number().nonnegative()),
  settings: SettingsSchema,
  bio: z.string(),
});
export type UserData = z.infer<typeof UserDataSchema>;

export const QaReplySchema = z.object({ id: z.string(), author: z.string(), role: z.enum(["student", "instructor", "admin"]), text: z.string(), at: z.string() });
export const QaThreadSchema = z.object({
  id: z.string(),
  courseSlug: z.string(),
  lessonId: z.string(),
  author: z.string(),
  text: z.string(),
  at: z.string(),
  replies: z.array(QaReplySchema),
  resolved: z.boolean().optional(),
});
export type QaThread = z.infer<typeof QaThreadSchema>;

export const ProfileSchema = z.object({
  name: z.string().min(2, { message: "nameShort" }),
  bio: z.string().max(240, { message: "bioLong" }),
  weeklyGoal: z.number().int().min(1).max(30),
});
export type ProfileInput = z.infer<typeof ProfileSchema>;

export const PasswordChangeSchema = z
  .object({
    current: z.string().min(1, { message: "required" }),
    next: z.string().min(8, { message: "passwordShort8" }),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { path: ["confirm"], message: "passwordMismatch" });
export type PasswordChangeInput = z.infer<typeof PasswordChangeSchema>;

export const ReviewInputSchema = z.object({
  rating: z.number().int().min(1, { message: "ratingRequired" }).max(5),
  comment: z.string().max(400, { message: "commentLong" }),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
```

### `admin.ts`

```ts
import { z } from "zod";

export const CouponSchema = z.object({
  code: z.string().min(3).max(20),
  percent: z.number().int().min(1).max(100),
  active: z.boolean(),
  deletedAt: z.string().optional(),
});
export type Coupon = z.infer<typeof CouponSchema>;

/**
 * Every admin change is "set table[key] to a value". Storing before/after makes any change revertible,
 * including reverts themselves (a revert is just another change).
 */
export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  actingAs: z.object({ id: z.string(), name: z.string() }).optional(),
  action: z.enum(["create", "update", "delete", "restore", "revert", "refund", "ban", "unban"]),
  entity: z.string(),
  summary: z.string(),
  table: z.string(),
  key: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  revertedBy: z.string().optional(),
  revertOf: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
```

### Checkout form (`src/lib/learning/card.ts`)

```ts
export const CheckoutSchema = z.object({
  name: z.string().min(2, { message: "nameShort" }),
  email: z.email({ message: "invalidEmail" }),
  number: z.string().refine(luhnValid, { message: "cardInvalid" }),
  expiry: z.string().refine((v) => expiryValid(v), { message: "expiryInvalid" }),
  cvc: z.string().regex(/^\d{3,4}$/, { message: "cvcInvalid" }),
});
export type CheckoutInput = z.infer<typeof CheckoutSchema>;
```

(`luhnValid` = Luhn checksum over 13–19 digits; `expiryValid` = `MM/YY`, month 1–12, valid through the last day of that month.)

## Appendix B — Types that are not Zod schemas

```ts
// src/lib/builder/draft.ts — body of POST/PUT /instructor/courses
type L = Localized;
type DraftSection = { id: string; title: L; lessons: Lesson[] };
type Draft = {
  slug?: string;                 // ignored on create; the server decides
  instructorId: string;          // admins may set it; instructors: must equal their own
  title: L; subtitle: L; description: L;
  category: string;              // category slug
  level: "beginner" | "intermediate" | "advanced";
  language: "en" | "ar";
  price: number; originalPrice?: number;
  tags: string[];
  outcomes: L[]; requirements: L[];
  sections: DraftSection[];
  quiz: QuizQuestion[];
  status: "draft" | "published" | "archived";
  thumbnail?: string;
};

// src/lib/catalog.ts
type CourseQuery = {
  q?: string; category?: string[]; level?: Level[]; language?: ("en" | "ar")[];
  price?: "free" | "paid"; minRating?: number;
  sort?: "popular" | "rating" | "newest" | "price-asc" | "price-desc";
  page?: number; pageSize?: number;
};

// src/lib/learning/leaderboard.ts
type LeaderboardEntry = { id: string; name: Localized; xp: number; me: boolean; rank: number };

// src/lib/api/admin.ts
type UserRow = Account & { enrollments: number; certificates: number };   // omit `password`
type OrderRow = Order & { userId: string; userName: string };
```

`Effects`, `DashboardData`, `StudentRow`, `CourseAnalytics`, `AdminOverview`, `CourseListResult` are defined inline in §5–§8.

## Appendix C — Frontend → endpoint map

| Frontend function | Endpoint |
| --- | --- |
| `api.listCourses` | `GET /courses` |
| `api.getCourse` | `GET /courses/:slug` |
| `api.getCoursesBySlugs` | `GET /courses/by-slugs` |
| `api.getRecommended` / `getRelated` | `GET /courses/recommended` / `GET /courses/:slug/related` |
| `api.getCategories` / `getInstructors` / `getInstructor` | `GET /categories` / `/instructors` / `/instructors/:id` |
| `api.getReviews(courseId)` | `GET /courses/:slug/reviews` (frontend must pass the slug) |
| `api.getRoadmaps` / `getRoadmap` / `getTestimonials` / `search` | `GET /roadmaps` / `/roadmaps/:slug` / `/testimonials` / `/search` |
| `api.login` / `register` / `forgotPassword` / `checkSession` / `changePassword` | `POST /auth/login` / `/auth/register` / `/auth/forgot-password`; `GET /auth/me`; `POST /auth/change-password` |
| `studentApi.getData` | `GET /me/learning` |
| `studentApi.enroll` | `POST /me/enrollments` |
| `studentApi.completeLesson` / `savePosition` | `POST /me/lessons/:id/complete` / `PUT /me/progress` |
| `studentApi.addNote` / `deleteNote` | `POST /me/notes` / `DELETE /me/notes/:id` |
| `studentApi.toggleWishlist` | `PUT`/`DELETE /me/wishlist/:slug` |
| `studentApi.markNotificationsRead` | `POST /me/notifications/read` |
| `studentApi.submitReview` / `updateProfile` / `updateSettings` | `PUT /me/reviews/:slug` / `PATCH /me/profile` / `PATCH /me/settings` |
| `studentApi.submitQuiz` (+ questions via `quizForCourse` today) | `POST /courses/:slug/quiz-attempts` (+ `GET /courses/:slug/quiz`) |
| `studentApi.checkout` | `POST /me/orders` (+ `POST /coupons/validate` for the cart) |
| `studentApi.getLeaderboard` | `GET /me/leaderboard` |
| `studentApi.getQa` / `askQuestion` / `replyToQuestion` | `GET`/`POST /courses/:slug/lessons/:lessonId/qa`; `POST /qa/:threadId/replies` |
| `studentApi.resetDemo` | none (development-only `POST /dev/reset` if wanted) |
| `instructorApi.*` | §7 |
| `adminApi.*` | §8 |
| `uploadVideo` (`lib/storage/upload.ts`) | §9 |
