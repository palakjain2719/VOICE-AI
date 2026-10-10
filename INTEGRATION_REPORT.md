# Integration report — 10 October 2026

## Starting point
There was no existing repository: the inputs were the four business files (`services.md`,
`qualified.md`, `pricing.md`, the September transcript PDF) and a spreadsheet of Vaani invite codes.
**No reference screenshots of the friend's dashboard were included**, so the layout follows the
written description in the brief (safety strip, pipeline cards, actions, AI summary, funnel, queues,
costs). No `.env.local` or credentials were provided, so **no live provider call was made**.

## Verified here
| Area | How |
|---|---|
| Typecheck, lint, production build | `npm run typecheck`, `npm run lint` (0 warnings), `npm run build` (all pages partially prerendered, APIs dynamic) |
| 168 automated tests | `npm test` |
| Database schema, constraints, RLS, SQL functions | all 4 migrations applied to real Postgres (PGlite) in `database.test.ts`; found and fixed two real bugs this way (a bad join in `dashboard_funnel`, a seed CTE that never published) |
| Qualification on the 15 transcript scenarios | `qualification.test.ts` |
| Pricing restriction | deflection on 12+ phrasings, disclosure detection, no guide figures reach the agent, guide not importable |
| Workflow behaviour (booking, conflicts, retries, idempotency, complaints, reconnects) | against an in-memory store with the same constraints |
| Provider request/response handling | **mocked** HTTP only |
| UI | rendered in a browser via the dev-only DEMO preview at desktop and 375 px widths, light and dark |
| Auth on routes | static audit of every route + live probe: unauthenticated → 401, unconfigured provider → generic 503 |

## Tooling for verifying live
- `npm run doctor` — read-only check of every provider from `.env.local`, with the fix for each failure.
- `npm run smoke -- --base <url>` — simulates one call end to end against a deployment (tool auth, webhook
  signature, pricing deflection, approved answers, qualification, real availability, optional real booking,
  duplicate webhook). Its records are flagged as test fixtures.
- `.env.local` already holds generated values for `CRON_SECRET`, `VOICE_TOOL_SECRET` and
  `TOKEN_ENCRYPTION_KEY` (copy the same values into Vercel), plus `GEMINI_MODEL` and local URLs.
- Supabase project `bkizxetbqmpzqtmfngkk` is reachable (REST answers 401 without a key, as expected).

## Verified LIVE (10 Oct 2026, with the keys you provided)
| Area | Result |
|---|---|
| Supabase | Migrations 1–5 applied to `bkizxetbqmpzqtmfngkk` in a dedicated `aangan` schema (26 tables, 31 RLS policies, 30 published knowledge articles); schema exposed to the Data API; other apps' tables untouched (15 `public` tables, their 150 `audit_log` rows intact). |
| Gemini (`gemini-3.8-flash`) | Real extraction + rules on 9 September transcripts: **9/9 match the rubric**. Answer selection: 6/6 (correct article, or fallback when nothing approved fits). Found and fixed: this model rejects `thinkingLevel: MINIMAL`; thinking tokens also count against the output budget. |
| End-to-end call path (local app → live Supabase + Gemini) | `npm run smoke`: tool auth, webhook signature, pricing deflection, approved answer, fallback + logging, red/green qualification, signed `call.completed` → processed with a real Gemini summary, duplicate delivery ignored, no HubSpot sync for test data. All test rows were then deleted. Webhook used a throwaway local secret, not real Vaani. |
| HubSpot (read) | contacts, deals, owners, pipelines readable. |

## Not verified (live) — and what each needs

| # | Integration | Status | Exact action needed |
|---|---|---|---|
| 1 | **Vaani: live tool calls during a call** | **Blocked — capability unconfirmed.** Vaani's public API ([OpenAPI](https://www.vaanilabs.in/openapi/v1/vaanivoice.yaml), [webhooks](https://www.vaanilabs.in/docs/api/webhooks)) documents session minting, meeting rooms, signed post-call webhooks and usage rollups. It does **not** document a flow calling an external URL mid-call; the WebSocket protocol only streams transcripts/audio, the SDK and MCP packages named in the docs are not published on npm, and the Flow Builder is behind login. | In the Vaani Flow Builder, check for an API/HTTP/function node. If present, point it at `/api/voice/tools/<tool>` with `Authorization: Bearer $VOICE_TOOL_SECRET`. If absent, ask Vaani support (hello@vaanilabs.in) whether tool calling is available; until then the app routes qualified callers to the review queue for human booking (it never books from a webhook). |
| 2 | Vaani: inbound phone routing | Unverified. Docs mention "Configure your Twilio number" in Quick Start; the changelog only mentions Twilio for **outbound**. | Configure the number in the Vaani dashboard and place a test call. |
| 3 | Vaani: webhook payload fields | Envelope + HMAC verified against docs; `data` contents are undocumented ("no sub-field is guaranteed"). The adapter maps common field names defensively and stores unknowns. | After the first real `call.completed`, check Calls → the call record. If transcript/duration are empty, share one redacted payload and extend `normaliseCallData`. |
| 4 | Vaani: account & key | The key provided (`vaani_…`) is rejected by the public API: `401 Missing or malformed Authorization: Bearer vv_live_... header`. Nothing was charged. | Sign up, top up the wallet, mint `vv_live_` key, register the webhook (store `vv_whk_` secret). Integrations → "Verify API key" (mints a short session; Vaani holds ₹1 that is reconciled). |
| 5 | Gemini | Code uses the official SDK `models.generateContent` with JSON schema output; not called live. | Set `GEMINI_API_KEY` and `GEMINI_MODEL` (Google lists `gemini-3.8-flash` / `gemini-3.6-flash` as stable on 10 Oct 2026). Integrations → Test. |
| 6 | Supabase | **Live and connected.** No admin user yet (no Auth users exist). | Create your user under Authentication → Users (invite or add), then I (or you) run `update aangan.app_users set roles = '{admin}' where email = '…';`. |
| 7 | HubSpot | Reads work. **Writes blocked:** creating custom properties and the new "Aangan Consultations" pipeline both return `MISSING_SCOPES` (needs `crm.schemas.contacts.write`, `crm.schemas.deals.write`). Contact/deal write scopes untested (would create records). | Add scopes `crm.schemas.contacts.write`, `crm.schemas.deals.write`, `crm.objects.contacts.write`, `crm.objects.deals.write` to the key (or create a service key with them), then `npm run hubspot:setup`; I then create the pipeline and save the stage mapping. |
| 8 | Calendar | **Cal.com verified live (11 Oct 2026):** event type + schedule created, free/busy read, booking created, idempotent re-book returned the same booking, cancellation succeeded. Google Calendar OAuth path kept as fallback, not called live. | Nothing for Cal.com. Bookings without a caller email use `CALCOM_FALLBACK_ATTENDEE_EMAIL`, so those callers get no Cal.com email. |
| 9 | Resend | Not called live. | Verify the sending domain, set `EMAIL_FROM`, Integrations → Check sender domain. |
| 10 | Vercel deploy | Not deployed (no Vercel/GitHub access in this session). | Import repo, set env vars, deploy; cron every 5/15 min needs a plan that allows it. |
| 11 | Escalation callback promise | Deliberately off. The agent promises a callback time only if Settings → Policies sets `complaintCallbackMinutes`. | Founder decides the policy and notification emails. |
| 12 | Founder decisions on DERIVED rules | Defaults in place (README §2 table). | Confirm: commercial minimum (500 sq ft), budget floor (₹2 lakh), 6–11-week timeline → review, locality lists. |

## Acceptance criteria
| # | Criterion | State |
|---|---|---|
| 1 | Live call reaches the agent | Pending Vaani setup (blockers 2, 4) |
| 2 | Agent follows approved context, asks qualification questions | Instructions generated from approved knowledge; live behaviour pending |
| 3 | Never gives a price | Enforced server-side + tested; agent wording pending live test |
| 4 | Deterministic, explainable classification | **Done**, tested |
| 5 | Eligible leads booked into real slots | Done in code + tested with mocks; needs blocker 1 and 8 |
| 6 | Accurate confirmation email after booking | Done + tested with mocks; needs 9 |
| 7 | HubSpot receives lead + deal | Done + tested with mocks; needs 7 |
| 8 | Dashboard shows real call + pipeline metrics | Done; populates once 6–7 are live |
| 9 | Duplicates prevented, failures handled | **Done**, tested (DB constraints + idempotency keys + queue) |
| 10 | Unanswered question → approved knowledge | **Done**, tested |
| 11 | Secure, responsive, deployed | Secure + responsive verified; deployment pending (10) |
| 12 | Credentials private, setup documented | **Done**: no secrets in code; `.env.local*` git-ignored; README §3 |

## Plan and checklist (what existed vs. what was built)
| Item | Existed | Built |
|---|---|---|
| Repository / framework | nothing | Next.js 16 App Router, TypeScript, Tailwind 4, Recharts, Vitest |
| Business rules | 3 markdown files + PDF | rules engine, pricing guard, approved knowledge seed, transcript regression tests |
| Database | Supabase URL only | 4 migrations: 26 tables, RLS for 3 roles, queue, rate limiter, funnel/cost functions |
| Integrations | none | adapters for Vaani, Gemini, Google Calendar, HubSpot, Resend |
| Dashboard | none (screenshots not supplied) | Overview, Funnel, Pipeline & revenue, Costs, Review queue, Calls, Knowledge, Integrations, Settings |
| Ops | none | job queue + cron, integration health, audit log, exception queue with retry |

Not built, by design: WhatsApp and web-form intake (out of scope for this version); a designer CRM
inside the app (HubSpot is the CRM); `POST /api/webhooks/hubspot` (not supported by service keys);
demo/historical data in the database (only a dev-only, labelled preview page).
