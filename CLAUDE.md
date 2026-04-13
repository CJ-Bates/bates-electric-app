# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bates Electric field-service app: technicians in the field fill out inspection forms on a phone (installable PWA), the office dashboard reviews them. Two-sided app with a shared Supabase backend.

## Layout

- `backend/` — Node/Express API (CommonJS, Express 5). Talks to Supabase and Resend.
- `frontend/` — Vanilla JS PWA (no bundler, no framework). Plain `.html` + `.js` + `.css` served statically. Service worker provides offline support in production.
- `backend/sql/001_initial_schema.sql` — canonical schema. Run manually in the Supabase SQL Editor; there is no migration runner.
- `reference/` — static HTML reference material, not shipped.

## Commands

All backend commands run from `backend/`:

```bash
npm install
node server.js                      # start API
node scripts/test-connections.js    # verify Supabase + Resend creds and schema
node scripts/test-inspections.js    # smoke-test inspections table
```

No build step, no linter, no test runner wired up (`npm test` is a placeholder). Frontend is served as static files — open `frontend/index.html` via any static server; `app.js` assumes the API is at `http://localhost:4000` when on localhost, so run the backend with `PORT=4000` in dev.

Required env vars in `backend/.env` (see `scripts/test-connections.js` for the full list): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `OFFICE_EMAIL`, `EMAIL_FROM`, `PORT`.

## Architecture — things you need to read multiple files to see

### Supabase client has three modes (`backend/lib/supabase.js`)

Pick deliberately; they have different trust levels:

- `supabaseAnon` — for unauthenticated operations on behalf of an end user (signup, login).
- `supabaseAdmin` — **service role, bypasses RLS**. Use only for trusted server-side lookups (e.g. verifying a token, reading a profile in middleware). Never return its results without enforcing permissions yourself.
- `supabaseForUser(accessToken)` — per-request client bound to the end user's JWT. **This is the default for route handlers** because reads/writes go through RLS, so policies enforce permissions instead of hand-written checks.

Route handlers under `/inspections` intentionally use `supabaseForUser(req.token)` so that RLS (not JS) decides who sees what. Don't "optimize" by switching to `supabaseAdmin`.

### Auth flow and role model

- Two roles: `tech` and `office`. Role is derived from email domain by `public.bates_role_for_email()`:
  - `*@bates-electric.com` → `office`
  - `*.bateselectric@gmail.com` → `tech`
- The Postgres trigger `on_auth_user_created` is the source of truth; it rejects signups from any other domain and auto-inserts a `profiles` row. The JS `allowedBatesEmail()` check in `routes/auth.js` is a fail-fast mirror, not the real gate.
- `middleware/auth.js` `requireAuth` verifies the bearer token with `supabaseAdmin.auth.getUser()`, loads the profile, and attaches `req.user`, `req.profile`, and `req.token`. Downstream handlers pass `req.token` into `supabaseForUser()` to keep RLS in the loop.

### RLS is the authorization layer

All permission rules live in `001_initial_schema.sql`, not in Express:

- Techs can only see/insert/update their own inspections. Office sees everything and is the only role that can delete.
- `inspection_photos` policies mirror the parent inspection.
- Storage bucket `inspection-photos` enforces the same rule at the object level — photo filenames must be `<inspection_id>/...` so the storage policy can check ownership via `split_part(name, '/', 1)`.

When changing any permission behavior, update the SQL file and re-run it; don't add JS checks that duplicate RLS.

### Inspection data shape

`inspections` stores the full form blob in JSONB (`data`) plus four denormalized columns (`job_date`, `job_number`, `customer_name`, `customer_email`) extracted from the blob by `extractIndexed()` in `routes/inspections.js`. The denormalized columns exist purely so the office dashboard can filter/sort without scanning JSON. Whenever the form adds a new *filterable* field, both the extractor and the schema need to change together.

`status` is `draft` or `submitted` — drafts support autosave via `PATCH /inspections/:id`.

### Frontend shape

- `frontend/index.html` is the login page; `home.html` is the post-login hub; `inspection.html` is the form.
- `inspection-fields.js` holds row definitions as data (100+ Y/N/NA rows) that `inspection.html` renders via `data-rows="..."` attributes — don't hand-write these rows in HTML.
- Auth token is stored in `localStorage` or `sessionStorage` depending on the "Remember me" checkbox; code intentionally clears the unused store to avoid two stale tokens. Keep that invariant if you touch token storage.
- Service worker is deliberately skipped on `localhost` (and old registrations are unregistered) so dev changes aren't cached. Don't "fix" this.

### Server mounts `/auth` twice

`server.js` mounts `authRoutes` at both `/auth` and `/` so `GET /me` works without the `/auth` prefix. This is intentional — don't consolidate.
