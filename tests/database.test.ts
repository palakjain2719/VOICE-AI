/**
 * Applies every Supabase migration to a real Postgres (PGlite, in-process) with a minimal stub of
 * Supabase's auth schema and roles, then checks constraints, RLS and the dashboard aggregates.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;
const FOUNDER = "11111111-1111-1111-1111-111111111111";
const OPERATOR = "22222222-2222-2222-2222-222222222222";
const NOBODY = "33333333-3333-3333-3333-333333333333";

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? "authenticated" : "anon"}; set search_path = aangan, public; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role; set search_path = aangan, public, extensions;");
  }
}
const rows = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const dir = join(__dirname, "../supabase/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  // Unqualified names in these tests resolve to the app's own schema, as the API client does.
  await db.exec("alter role postgres set search_path = aangan, public, extensions; set search_path = aangan, public, extensions;");
  await db.exec("alter role authenticated set search_path = aangan, public; alter role anon set search_path = aangan, public;");
  await db.exec(`
    insert into auth.users (id, email) values ('${FOUNDER}', 'founder@example.com'), ('${OPERATOR}', 'ops@example.com'), ('${NOBODY}', 'new@example.com');
    update app_users set roles = '{founder}' where id = '${FOUNDER}';
    update app_users set roles = '{operator}' where id = '${OPERATOR}';
  `);
}, 60_000);

afterAll(async () => db?.close());

describe("migrations", () => {
  it("creates nothing in the shared public schema", async () => {
    expect(await rows("select table_name from information_schema.tables where table_schema = 'public'")).toEqual([]);
    expect((await rows("select count(*)::int as n from information_schema.tables where table_schema = 'aangan'"))[0].n).toBe(28);
  });


  it("seed knowledge: every article published at v1, no pricing figures", async () => {
    const r = await rows("select a.slug, v.version, v.spoken_answer from knowledge_articles a join knowledge_versions v on v.id = a.published_version_id");
    expect(r.length).toBeGreaterThan(25);
    expect(r.every((x) => x.version === 1)).toBe(true);
    expect(r.map((x) => x.spoken_answer).join(" ")).not.toMatch(/₹|\d\s*lakh/i);
  });

  it("new auth users get an app_users row with no roles", async () => {
    expect(await rows(`select roles::text as roles from app_users where id = '${NOBODY}'`)).toEqual([{ roles: "{}" }]);
  });
});

describe("constraints that prevent duplicates", () => {
  it("one call per provider call id, one live lead per phone", async () => {
    await db.exec(`insert into calls (provider, provider_call_id, started_at) values ('vaani', 'dup-1', now())`);
    await expect(db.exec(`insert into calls (provider, provider_call_id) values ('vaani', 'dup-1')`)).rejects.toThrow(/unique/i);
    await db.exec(`insert into leads (phone_normalized) values ('+919800000001')`);
    await expect(db.exec(`insert into leads (phone_normalized) values ('+919800000001')`)).rejects.toThrow(/unique/i);
    await db.exec(`insert into leads (phone_normalized, is_test) values ('+919800000001', true)`); // fixtures stay isolated
  });

  it("no overlapping live appointments for one designer; one live appointment per lead", async () => {
    const [{ id: d }] = await rows(`insert into designers (name) values ('Asha') returning id`);
    const [{ id: l1 }] = await rows(`insert into leads (name) values ('A') returning id`);
    const [{ id: l2 }] = await rows(`insert into leads (name) values ('B') returning id`);
    await db.exec(`insert into appointments (lead_id, designer_id, start_at, end_at, status, idempotency_key) values ('${l1}', '${d}', '2026-10-14 10:00+05:30', '2026-10-14 11:00+05:30', 'confirmed', 'k1')`);
    await expect(db.exec(`insert into appointments (lead_id, designer_id, start_at, end_at, status, idempotency_key) values ('${l2}', '${d}', '2026-10-14 10:30+05:30', '2026-10-14 11:30+05:30', 'pending', 'k2')`)).rejects.toThrow(/appointments_no_overlap|conflicting key/i);
    await expect(db.exec(`insert into appointments (lead_id, designer_id, start_at, end_at, status, idempotency_key) values ('${l1}', null, '2026-10-20 10:00+05:30', '2026-10-20 11:00+05:30', 'pending', 'k3')`)).rejects.toThrow(/unique/i);
    await expect(db.exec(`insert into appointments (lead_id, designer_id, start_at, end_at, status, idempotency_key) values ('${l2}', '${d}', '2026-10-21 10:00+05:30', '2026-10-21 11:00+05:30', 'pending', 'k1')`)).rejects.toThrow(/unique/i);
    // A cancelled booking frees the slot.
    await db.exec(`update appointments set status = 'cancelled' where idempotency_key = 'k1'`);
    await db.exec(`insert into appointments (lead_id, designer_id, start_at, end_at, status, idempotency_key) values ('${l2}', '${d}', '2026-10-14 10:30+05:30', '2026-10-14 11:30+05:30', 'pending', 'k4')`);
  });

  it("duplicate webhook events and lead events are rejected", async () => {
    await db.exec(`insert into integration_events (provider, event_type, external_event_id) values ('vaani', 'call.completed', 'evt_x')`);
    await expect(db.exec(`insert into integration_events (provider, event_type, external_event_id) values ('vaani', 'call.completed', 'evt_x')`)).rejects.toThrow(/unique/i);
    await db.exec(`insert into lead_events (event_type, dedupe_key) values ('booked', 'appt:1')`);
    await expect(db.exec(`insert into lead_events (event_type, dedupe_key) values ('booked', 'appt:1')`)).rejects.toThrow(/unique/i);
  });
});

describe("job queue and rate limiting", () => {
  it("claims ready jobs once and skips future ones", async () => {
    await db.exec(`insert into jobs (type, idempotency_key) values ('t', 'j1'), ('t', 'j2'); insert into jobs (type, idempotency_key, run_after) values ('t', 'j3', now() + interval '1 hour');`);
    const first = await rows(`select idempotency_key from claim_jobs(10, array['t'])`);
    expect(first.map((r) => r.idempotency_key).sort()).toEqual(["j1", "j2"]);
    expect(await rows(`select * from claim_jobs(10, array['t'])`)).toEqual([]);
  });

  it("rate_limit_hit allows up to the max per window", async () => {
    const r = [];
    for (let i = 0; i < 4; i++) r.push((await rows(`select rate_limit_hit('b1', 60, 3) as ok`))[0].ok);
    expect(r).toEqual([true, true, true, false]);
  });
});

describe("row level security", () => {
  beforeAll(async () => {
    const [{ id: c }] = await rows(`insert into calls (provider, provider_call_id, started_at, answered, status, call_type) values ('vaani', 'rls-1', now(), true, 'completed', 'new_enquiry') returning id`);
    await db.exec(`insert into call_transcripts (call_id, transcript) values ('${c}', 'Caller: secret details')`);
    await db.exec(`insert into restricted_documents (slug, title, body) values ('internal-pricing-guide', 'Pricing', 'internal')`);
  });

  it("anonymous visitors read nothing", async () => {
    expect(await as(null, () => rows("select id from calls"))).toEqual([]);
    expect(await as(null, () => rows("select id from leads"))).toEqual([]);
  });

  it("a signed-in user without a role reads nothing", async () => {
    expect(await as(NOBODY, () => rows("select id from calls"))).toEqual([]);
  });

  it("founders see call metadata but not transcripts, the pricing guide or the audit log", async () => {
    expect((await as(FOUNDER, () => rows("select id from calls"))).length).toBeGreaterThan(0);
    expect(await as(FOUNDER, () => rows("select * from call_transcripts"))).toEqual([]);
    expect(await as(FOUNDER, () => rows("select * from restricted_documents"))).toEqual([]);
    expect(await as(FOUNDER, () => rows("select * from audit_log"))).toEqual([]);
  });

  it("operators can read transcripts but cannot edit knowledge or read OAuth credentials", async () => {
    expect((await as(OPERATOR, () => rows("select * from call_transcripts"))).length).toBe(1);
    await as(OPERATOR, () => db.exec(`update knowledge_versions set spoken_answer = 'hacked'`));
    expect((await rows(`select count(*)::int as n from knowledge_versions where spoken_answer = 'hacked'`))[0].n).toBe(0);
    await db.exec(`insert into google_credentials (google_account_email, refresh_token_encrypted) values ('a@example.com', 'v1.x.y.z')`);
    expect(await as(OPERATOR, () => rows("select * from google_credentials"))).toEqual([]);
  });

  it("only admins can grant roles", async () => {
    await as(FOUNDER, () => db.exec(`update app_users set roles = '{admin}' where id = '${FOUNDER}'`));
    expect((await rows(`select roles::text as roles from app_users where id = '${FOUNDER}'`))[0].roles).toBe("{founder}");
  });
});

describe("dashboard_funnel", () => {
  it("counts live production activity only and excludes test fixtures", async () => {
    await db.exec(`delete from lead_events; delete from call_qualifications; delete from appointments; update calls set lead_id = null; delete from calls; delete from leads;`);
    const [{ id: lead }] = await rows(`insert into leads (name, qualification_status, project_type) values ('Live', 'green', '2BHK') returning id`);
    const [{ id: tlead }] = await rows(`insert into leads (name, qualification_status, is_test) values ('Fixture', 'green', true) returning id`);
    const [{ id: c1 }] = await rows(`insert into calls (provider_call_id, started_at, answered, status, call_type, lead_id) values ('f1', now(), true, 'completed', 'new_enquiry', '${lead}') returning id`);
    await db.exec(`insert into calls (provider_call_id, started_at, answered, status, call_type) values ('f2', now(), false, 'failed', 'unknown')`);
    await db.exec(`insert into calls (provider_call_id, started_at, answered, status, call_type, is_test, production_call) values ('f3', now(), true, 'completed', 'new_enquiry', true, false)`);
    await db.exec(`insert into call_qualifications (call_id, lead_id, status, criteria, facts, rules_version, config_hash) values ('${c1}', '${lead}', 'green', '{}', '{}', 'v', 'h')`);
    await db.exec(`insert into lead_events (lead_id, event_type, dedupe_key) values ('${lead}', 'qualified', 'lead:${lead}'), ('${lead}', 'booked', 'appt:a1');
                   insert into lead_events (lead_id, event_type, dedupe_key, is_test) values ('${tlead}', 'qualified', 'lead:${tlead}', true);`);
    const f = await as(FOUNDER, async () => (await rows(`select dashboard_funnel(now() - interval '1 day', now() + interval '1 day') as f`))[0].f as Record<string, number>);
    expect(f).toMatchObject({ incoming: 2, answered: 1, failed: 1, green: 1, qualified: 1, booked: 1, won: 0, new_enquiries_evaluated: 1 });
    const filtered = await as(FOUNDER, async () => (await rows(`select dashboard_funnel(now() - interval '1 day', now() + interval '1 day', null, 'Office') as f`))[0].f as Record<string, number>);
    expect(filtered).toMatchObject({ incoming: 0, qualified: 0 });
    const anon = await as(NOBODY, async () => (await rows(`select dashboard_funnel(now() - interval '1 day', now() + interval '1 day') as f`))[0].f as Record<string, number>);
    expect(anon.incoming).toBe(0);
  });
});

describe("operations views (migration 6)", () => {
  it("assigns review lanes by kind", async () => {
    await db.exec(`insert into exceptions (kind, title, dedupe_key) values ('ambiguous_qualification', 'a', 'lane-1'), ('failed_call', 'b', 'lane-2'), ('hubspot_failure', 'c', 'lane-3'), ('complaint', 'd', 'lane-4')`);
    const r = await rows(`select dedupe_key, lane from exceptions where dedupe_key like 'lane-%' order by dedupe_key`);
    expect(r.map((x) => x.lane)).toEqual(["designer", "callback", "admin", "complaint"]);
  });

  it("personal to-do tables were removed (migration 7)", async () => {
    expect(await rows("select table_name from information_schema.tables where table_schema = 'aangan' and table_name in ('todos', 'suggestion_dismissals')")).toEqual([]);
  });

  it("dashboard_kpis counts after-hours calls, durations and backlog; dashboard_demand groups demand", async () => {
    await db.exec(`delete from lead_events; delete from call_qualifications; delete from appointments; update calls set lead_id = null; delete from calls; delete from leads;`);
    // 2026-10-10 is a Saturday. 11:00 IST is inside hours; 22:30 IST is after hours; Sunday is closed.
    await db.exec(`insert into calls (provider_call_id, started_at, answered, status, duration_seconds) values
      ('k1', '2026-10-10 11:00+05:30', true, 'completed', 100),
      ('k2', '2026-10-10 22:30+05:30', true, 'completed', 400),
      ('k3', '2026-10-11 12:00+05:30', true, 'completed', 60)`);
    await db.exec(`insert into leads (locality, project_segment, qualification_status, decline_category, created_at) values
      ('kothrud', 'residential', 'green', null, '2026-10-10 12:00+05:30'),
      ('kothrud', 'residential', 'red', 'area', '2026-10-10 12:00+05:30'),
      (null, 'commercial', 'red', 'category', '2026-10-10 12:00+05:30')`);
    const k = (await as(FOUNDER, async () => (await rows(`select dashboard_kpis('2026-10-09', '2026-10-13') as k`))[0].k)) as Record<string, number>;
    expect(k).toMatchObject({ calls: 3, after_hours: 2, over_5_min: 1, avg_duration_seconds: 187 });
    const d = (await as(FOUNDER, async () => (await rows(`select dashboard_demand('2026-10-09', '2026-10-13') as d`))[0].d)) as Record<string, { label: string; n: number }[]>;
    expect(d.localities[0]).toEqual({ label: "Kothrud", n: 2 });
    expect(d.declines.map((x) => x.label).sort()).toEqual(["area", "category"]);
    expect(d.project_mix.find((x) => x.label === "residential")?.n).toBe(2);
  });
});

