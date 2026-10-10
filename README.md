# Aangan Studio — Voice AI Enquiry Desk

Incoming phone call → Vaani voice agent → approved answers → structured facts → deterministic
qualification → designer consultation booked in Google Calendar → confirmation email (Resend) →
qualified lead and deal in HubSpot → founder dashboard (Vercel + Supabase).

> **Status:** code complete and tested against mocks and a real Postgres (PGlite). No live provider
> credentials were available while building, so **no live integration has been verified yet**.
> See [`INTEGRATION_REPORT.md`](INTEGRATION_REPORT.md) for exactly what is verified and what each
> blocker needs.

---

## 1. Architecture

| Layer | Technology | Where |
|---|---|---|
| Voice agent | Vaani Labs (Flow Builder, Twilio number) | configured in the Vaani dashboard |
| Live tools for the agent | Next.js route handlers | `src/app/api/voice/tools/[tool]` |
| Post-call events | Vaani signed webhooks | `src/app/api/webhooks/vaani` |
| Extraction / article selection | Gemini Flash (`@google/genai`, structured JSON output) | `src/integrations/gemini` |
| Qualification | Deterministic rules engine | `src/domain/qualification` |
| Pricing safeguards | Server-side guard + approved deflection | `src/domain/pricing/guard.ts` |
| Knowledge | Versioned, human-approved articles | `src/domain/knowledge`, `knowledge_*` tables |
| Calendar | Google Calendar API v3, per-designer OAuth | `src/integrations/google` |
| Email | Resend REST (idempotency keys) | `src/integrations/resend` |
| CRM | HubSpot CRM v3 via service key | `src/integrations/hubspot`, `src/server/services/hubspot-sync.ts` |
| Database / auth | Supabase Postgres + Auth + RLS | `supabase/migrations` |
| Retries | DB-backed job queue + Vercel Cron | `jobs` table, `src/server/services/jobs.ts` |
| Dashboard | Next.js 16 App Router, Tailwind 4, Recharts | `src/app/(dash)` |

```
src/
  app/(dash)/        Overview, Funnel, Pipeline, Costs, Review queue, Calls, Knowledge, Integrations, Settings
  app/api/           Route handlers (webhooks, voice tools, cron, dashboard, admin)
  components/        UI kit, charts, client forms
  domain/            Pure business logic: qualification, pricing guard, knowledge, slots, metrics
  integrations/      Provider adapters: vaani, gemini, google, hubspot, resend
  server/            Auth guards, HTTP helpers, settings, Store (data access), workflow services
supabase/migrations/ Schema, RLS + SQL functions, auth trigger, generated knowledge seed
business-source/     services.md, qualified.md, transcript PDF (source of truth; pricing guide is git-ignored)
tests/               Vitest suites (mocked providers + PGlite database)
```

### Data flow of a call

1. **During the call** the Vaani flow calls the live tools with `Authorization: Bearer $VOICE_TOOL_SECRET`:
   `save_intake` (keeps partial data if the line drops) → `answer_question` (approved answer, pricing
   deflection or fallback + log) → `evaluate_qualification` (rules engine; returns the next clarifying
   question or the approved closure) → `get_availability` (real free/busy) → `book_consultation`
   (revalidates, writes the Google event, then confirms) → optional `escalate` / `log_unanswered_question`.
2. **After booking**, jobs send the confirmation email and sync HubSpot (both idempotent, retried).
3. **After the call** Vaani posts `call.completed` / `call.failed` / `usage.charged`. The webhook verifies
   the HMAC, de-duplicates on the `evt_` id, stores the event and queues processing: transcript,
   status, duration, provider cost, Gemini summary/extraction, pricing scan of the agent's turns,
   complaint/follow-up routing, and (only if no live evaluation happened) a post-call qualification.
   **The webhook never books.** A qualified caller with no booking becomes a "booking not completed"
   item for a human.
4. **Every 15 minutes** HubSpot deals are pulled into a read-only mirror (`hubspot_deals`) and stage
   progress becomes funnel events (consultation completed, deal open, won, lost).

## 2. Business rules — how the source files are implemented

### Qualification (`qualified.md`)
Gemini or the agent supplies facts; `evaluate()` decides. Each criterion is `pass | fail | unclear`:

| Outcome | Rule |
|---|---|
| **RED** | any criterion clearly fails → no booking, no HubSpot deal, approved closure (2+ failures → the exact multi-fail line from `qualified.md`) |
| **needs_clarification** | criterion 1, 2 or 3 unclear and not yet asked → one direct question |
| **needs_review** | criterion 1–3 still unclear after asking (or a tight-but-possible timeline) → review queue, no booking |
| **AMBER** | only budget (4) or decision-maker (5) unclear → qualified, uncertainty written to HubSpot |
| **GREEN** | everything passes |

Every evaluation stores the facts, per-criterion reasons, rules version and a config hash.

**Ambiguities resolved as configurable decisions** (Settings → Qualification & booking; each marked DERIVED in `src/domain/qualification/config.ts`):

| Topic | Source says | Default | Why |
|---|---|---|---|
| Out-of-scope project types (restaurant, hotel, retail, gym) | `services.md` exclusions; not one of the 5 criteria | evaluated under criterion 1 ("real project within Aangan's scope") | avoids inventing a sixth criterion |
| Commercial size ceiling | "approximately 3,000 sq ft" | fail above 3,300 (10% tolerance) | "approximately" needs a number |
| Commercial minimum | not in source files; T18 front desk said "500 sq ft or more" | 500 sq ft | **confirm with founder** |
| Timeline | services: no project needing completion < 6 weeks; design 3–4 + execution 8–16 weeks | < 6 weeks → fail; 6–11 weeks → human review; ≥ 11 → pass | `qualified.md`'s "8–10 weeks of the consultation" wording is ambiguous |
| Budget "clearly below" | example: ₹1–1.5 lakh for a full flat | volunteered max < ₹2,00,000 → fail | internal threshold only; never spoken |
| Budget not mentioned | "treat as qualified" | pass (not AMBER); switchable | otherwise nearly every lead would be AMBER |
| Researching for family (T14) | "not sufficient on its own" | unclear → AMBER | rubric says don't push on 5 |
| Service-area localities | list in `services.md` + "adjoining areas" | listed areas + clearly-PMC/PCMC wards; ambiguous fringe → ask | editable list |
| Working hours for consultations | front desk 10am–7pm in transcripts | Mon–Sat 10:00–19:00, 60 min + 30 min buffer | editable |

### Pricing (`pricing.md`)
- The agent only ever receives the approved deflection (verbatim from `pricing.md`).
- `pricing.md` itself is **git-ignored** (`business-source/restricted/`), never imported by app code
  (a test enforces this), and can be loaded into the admin-only `restricted_documents` table with
  `npm run restricted:load`.
- `answer_question` deflects any pricing request (direct, repeated, rate card, per-sq-ft, "would 10 lakh
  be enough", embedded in another question, Hindi phrasing) and every outgoing answer passes
  `enforcePricingPolicy`, which replaces any price-like text with the deflection.
- Post-call, the agent's own turns are scanned for disclosures → critical review item + safety card.
- No deal amount or close date is ever written to HubSpot; revenue comes only from HubSpot amounts.

### Knowledge loop
Unanswered question → approved fallback spoken → question logged (deduplicated, counted) → admin writes an
answer → automatic checks (no pricing, ≤ 450 chars, example questions route to it, regression suite from
the transcripts still routes correctly) → admin approves & publishes → version, approver and time recorded,
audit log written → "Export agent instructions" regenerates the Vaani prompt. Nothing retrains a model.

## 3. Setup

### Prerequisites
Node ≥ 20.9 (tested on 24), npm.

```bash
npm install
cp .env.local.template .env.local   # fill in values; .env.local is git-ignored
npm run doctor                      # read-only check of every provider, with fix hints
npm run dev
```

### Environment variables (`.env.example`)
| Variable | Notes |
|---|---|
| `APP_BASE_URL` | e.g. `https://aangan.vercel.app` — used for webhook/tool URLs and HubSpot call links |
| `CRON_SECRET` | random string; Vercel Cron sends it as a Bearer token |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` — encrypts Google refresh/access tokens (AES-256-GCM) |
| `VOICE_TOOL_SECRET` | random string the Vaani flow sends to `/api/voice/tools/*` (added; not in the original list) |
| `VAANI_API_KEY` / `VAANI_WEBHOOK_SECRET` / `VAANI_FLOW_ID` | `vv_live_…` key, `vv_whk_…` webhook secret, optional flow slug |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | as of 10 Oct 2026 Google lists `gemini-3.8-flash` and `gemini-3.6-flash` as stable — re-check the [models page](https://ai.google.dev/gemini-api/docs/models) |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` | secret key is server-only |
| `HUBSPOT_SERVICE_KEY` | Development → Keys → Service Keys |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | redirect = `${APP_BASE_URL}/api/auth/google/callback` |
| `RESEND_API_KEY` / `EMAIL_FROM` | `EMAIL_FROM` must use a domain verified in Resend |

### Supabase
All Aangan objects live in the **`aangan` schema** because the project's `public` schema belongs to other
apps (it already has an `audit_log` and `email_status` that would clash). The schema is listed under
Data API → Exposed schemas, and the app's clients use it via `SUPABASE_DB_SCHEMA` (default `aangan`).

**Status (10 Oct 2026): migrations 1–5 are applied to project `bkizxetbqmpzqtmfngkk` and `aangan` is exposed.**

1. (Already done) Apply migrations in order — either paste `supabase/migrations/2026101000000{1..4}_*.sql` into the SQL editor,
   or `npx supabase login && npx supabase link --project-ref bkizxetbqmpzqtmfngkk && npx supabase db push`.
2. Authentication → create users (invite). Each new user gets an `app_users` row with **no roles**.
3. Bootstrap the first admin in the SQL editor:
   `update app_users set roles = '{admin}' where email = 'founder@aangan.example';`
   Further roles are granted in Settings → Users & roles.
4. Optional: `npm run restricted:load` to store the pricing guide for admins.

Roles: **founder** (dashboards, pipeline, costs, review queue read-only), **operator** (call records and
transcripts, works the queue, manual booking/retries), **admin** (everything incl. knowledge and settings).

### Vaani Labs
1. Sign up at vaanilabs.in (your cohort invite code is in the spreadsheet you shared), top up the wallet,
   mint an API key at `/api-keys`.
2. Quick Start → configure the Twilio number so incoming calls reach your flow.
3. Build the flow: paste the output of Knowledge → **Export agent instructions**.
4. **Verify in Flow Builder whether nodes can call an external HTTPS endpoint during the call** (an API /
   webhook / function node). If yes, wire each tool to `${APP_BASE_URL}/api/voice/tools/<tool>` with header
   `Authorization: Bearer <VOICE_TOOL_SECRET>` and JSON bodies as in `src/server/services/voice-tool-schemas.ts`.
   This is not documented publicly — see the integration report.
5. Dashboard → Webhooks: register `${APP_BASE_URL}/api/webhooks/vaani` for `call.completed`, `call.failed`,
   `usage.charged`; store the `vv_whk_` secret as `VAANI_WEBHOOK_SECRET`. Use the dashboard "Test" button
   (sends `webhook.ping`).

### HubSpot
1. Create a service key with scopes for contacts (read/write), deals (read/write), owners (read),
   schemas/properties (read/write) and pipelines (read).
2. Integrations → HubSpot → **Check scopes**, then **Create custom properties** (group "Aangan Studio").
3. Settings → HubSpot pipeline: map *qualified*, *consultation booked*, *consultation completed* and
   *deal open/proposal* to your real stages. Without this mapping, syncing fails loudly instead of guessing.
4. Settings → Designers: set each designer's HubSpot owner.
5. Designers move deals through later stages and set amounts/close dates in HubSpot as usual.
   Service keys can't receive HubSpot webhooks (those belong to apps), so deals are pulled every 15 minutes.

### Google Calendar
1. Google Cloud → OAuth consent screen + OAuth client (Web). Enable the Calendar API. Authorised redirect URI:
   `${APP_BASE_URL}/api/auth/google/callback`.
2. Settings → Designers → **Connect Google Calendar** — the designer signs in with their own account;
   choose the booking calendar; tick **Bookable**.
3. Scopes requested: `calendar.events`, `calendar.readonly`, `openid email`. Refresh tokens are stored encrypted.

### Resend
Verify the sending domain, set `EMAIL_FROM` (e.g. `Aangan Studio <hello@yourdomain>`), then
Integrations → Resend → **Check sender domain**.

## 4. Deploy to Vercel
1. Push to GitHub, import the repo in Vercel (framework: Next.js).
2. Add every variable from `.env.example` for Production (and Preview if used).
3. `vercel.json` schedules `/api/cron/jobs` every 5 minutes and `/api/cron/hubspot-sync` every 15 minutes —
   this needs a Vercel plan that allows sub-daily crons (Hobby allows daily only; jobs are also processed
   immediately after each webhook/booking, so cron is the retry safety net).
4. After deploy: set `APP_BASE_URL`, register the Vaani webhook, Google redirect URI, then run every check on
   the Integrations page.
5. Run the end-to-end smoke test from your machine (uses the secrets in `.env.local`; everything it creates is
   flagged as a test fixture, excluded from metrics and never synced to HubSpot):
   ```bash
   npm run smoke -- --base https://your-app.vercel.app
   npm run smoke -- --base https://your-app.vercel.app --book you@example.com   # also books a real slot + sends a real email
   ```
6. GitHub Actions (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on every push.

## 5. Testing

```bash
npm test          # vitest: 168 tests
npm run typecheck # next typegen + tsc
npm run lint
npm run build
```

| Suite | What it covers |
|---|---|
| `qualification.test.ts` | the 15 transcript scenarios + boundary rules, determinism, config hashing |
| `pricing-and-knowledge.test.ts` | deflection on direct/repeated/indirect/embedded requests, disclosure detection, no pricing figures in agent context or seed, no code imports the guide, answer routing, fallback, knowledge pre-publish checks |
| `workflows.test.ts` | live qualification, booking success/conflict/double-booking/auth failure/idempotency, email success/failure/no-email/retry, complaints, reconnects, post-call processing, pricing scan, provider costs, missing Gemini |
| `integrations.test.ts` | **mocked** HTTP for HubSpot (match/create/associate/forward-only stages/scopes/retry/deal mirror), Google (refresh, encrypted tokens, 409 idempotency, revoked grant), Resend (idempotency header, template), Vaani HMAC + payload mapping, slots, crypto, redaction |
| `database.test.ts` | all migrations applied to real Postgres (PGlite): uniqueness, no-overlap exclusion, job claiming, rate limiting, **RLS per role**, `dashboard_funnel` excluding test data |
| `routes-and-metrics.test.ts` | every API route has the right guard; secrets; pipeline maths; insights cite only counted values |

Mocked tests verify our code paths, **not** the live providers. Live checks:

```bash
npm run doctor            # read-only check of every provider
npm run check:extraction  # real Gemini extraction on transcript fixtures + answer selection (writes nothing)
npm run hubspot:setup     # creates Aangan custom properties, lists pipelines (needs schema write scopes)
npm run check:conversation # scripted calls through the conversation engine with real Gemini (writes nothing)
```

**Dev-only DEMO preview:** `npm run dev` then open `/dev/preview` — invented, clearly-labelled figures for
visual review only; returns 404 in production builds and never touches the database. No demo or
historical records are ever written to the database; the production dashboard starts empty.

## 6. Pages

| Page | For | What it shows |
|---|---|---|
| **Overview** `/` | founder, desk | "In short" summary from counted data (Gemini only rewords; numbers are checked), headline ledger (calls answered, answered after hours, qualified, booked, designer handoff time, weighted pipeline), call-to-signed-project funnel with show-up and win rates, **Guardrails** status list, **Demand** (areas, why enquiries weren't a fit, home vs office), **Needs a person** (lane counts + linked actions), latest calls |
| **Test call** `/test-call` | founder, desk | runs the whole flow map live: speak (Chrome speech recognition) or type as a caller; the agent replies by voice. Panels follow the map — ① trigger ② voice AI ③ inputs collected ④ knowledge used ⑤ AI processing (understand → extract → evaluate) ⑥ Red/Amber/Green and actions ⑦ outputs (booking, confirmation email, designer brief, follow-up tasks) + backend (call record, transcript, summary). Stored as test calls; the Overview's *Include test calls* switch shows them in the figures |
| **Pipeline** `/pipeline` | founder | HubSpot deals by stage and designer; month/quarter/year forecast |
| **Callbacks** `/desk` | front desk | one urgency-ordered list of complaints, unfinished enquiries and messages for named designers, with tap-to-call; today/tomorrow consultation timeline |
| **Decisions** `/exceptions` | operator, designer | three lanes — a designer's call, admin, call back — with *Approve & book*, *Not a fit*, and routing |
| Calls, Knowledge, Integrations, Settings | operator / admin | call records & transcripts, approved answers, provider health, configuration |

### Seven add-ons beyond the brief
1. **Designer handoff brief** — the assigned designer is emailed the full brief at booking; *time to handoff* is tracked.
2. **After-hours capture** — how many enquiries arrived when the studio was closed and were still answered.
3. **Decision lanes** — anything the rules can't settle goes to the right person, decided in one click
   (approve → recorded as a human decision, HubSpot sync, booking callback; not a fit → polite closing email).
4. **Messages for named people** — callers asking for a designer or with a project update leave a message
   (voice tool `take_message`), routed and emailed to that designer when the name is unambiguous.
5. **Demand insights** — areas, decline reasons and project mix, for marketing and service-area decisions.
6. **Callbacks desk** — one prioritised list for the front desk with today's schedule alongside.
7. **Cost guardrails** — a daily voice-spend alert and long-call tracking in the Guardrails list.

Design: top navigation, warm paper background, serif display type (Fraunces) for headings and figures, flat
hairline cards; lavender, pale blue and mint are used only as accents and chart tones.

## 7. Metric definitions

| Metric | Definition |
|---|---|
| Total production calls | calls with `production_call = true`, `is_test = false`, `started_at` in period |
| Answered / failed | provider-confirmed (`answered`), `status in (failed, missed)` |
| Green / Amber / Red | latest qualification per call in period |
| Qualification rate | eligible (G+A) leads ÷ answered new-enquiry calls with a G/A/R result |
| Funnel stages | distinct leads whose stage event occurred in the period (`lead_events`); completed / open deal / won / lost come from HubSpot stage progress |
| Booking rate | booked ÷ qualified (funnel step) |
| Open pipeline | Σ amount of open HubSpot deals that have an amount; deals without one are counted, not valued |
| Weighted pipeline | Σ amount × stage probability (from the HubSpot pipeline), deals missing either are excluded and counted |
| Closed-won revenue | Σ amount of won deals with close date in period |
| Forecast | open deals by expected close month/quarter/year, unweighted and weighted; deals without a close date are excluded and counted |
| Enquiries staff couldn't take | calls starting outside the configured front-desk hours (Settings → booking hours; default Mon–Sat 10:00–19:00 IST) |
| Time to designer handoff | median of (handoff time − call end) where handoff = designer brief email sent, or the HubSpot deal synced with an owner |
| Review backlog | open items in the designer / admin / callback lanes; oldest age vs a 24 h target |
| Show-up rate | consultations marked completed (HubSpot stage) ÷ consultations due in the period |
| Win rate after meeting | won ÷ consultations completed (period events) |
| Senior alerted in | median time from complaint logged to escalation notification sent |
| Cost per call / qualified lead / booking | recorded INR cost ÷ count; shown only when Vaani charges exist for the period. Vaani costs are provider-reported; Gemini costs are estimates from admin-entered rates |

A booking is never counted as revenue, and a consultation is only "completed" when the designer moves the
HubSpot deal to the mapped stage.
