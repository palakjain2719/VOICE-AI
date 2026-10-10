/**
 * Provider adapters against MOCKED HTTP responses (repeatable, no credentials). These verify our
 * request/response handling, not the live providers — see INTEGRATION_REPORT.md for live status.
 */
import { describe, expect, it, vi } from "vitest";
import { hmacSha256Hex, encryptToken, decryptToken } from "@/lib/crypto";
import { redact } from "@/lib/log";
import { normaliseEmail, normalisePhone } from "@/lib/phone";
import { normaliseCallData, verifyVaaniSignature, VaaniEnvelopeSchema } from "@/integrations/vaani/webhook";
import { hubspotClient, HubSpotError } from "@/integrations/hubspot/client";
import { HubSpotSetupError, syncDealsFromHubSpot, syncLeadToHubSpot, type PipelineMapping } from "@/server/services/hubspot-sync";
import { eventIdFor, googleCalendar, GoogleAuthError } from "@/integrations/google/calendar";
import { renderConfirmationEmail, resendSender } from "@/integrations/resend/email";
import { computeSlots, DEFAULT_BOOKING_CONFIG } from "@/domain/booking/slots";
import { memoryStore } from "./support/memory-store";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Vaani webhook", () => {
  const secret = "vv_whk_testsecret";
  const body = JSON.stringify({ id: "evt_1", type: "call.completed", created: 1714003200, data: {} });
  it("accepts a correct HMAC-SHA256 signature over the raw body", () => {
    expect(verifyVaaniSignature(body, `sha256=${hmacSha256Hex(secret, body)}`, secret)).toBe(true);
  });
  it("rejects tampered bodies, wrong secrets and malformed headers", () => {
    const sig = `sha256=${hmacSha256Hex(secret, body)}`;
    expect(verifyVaaniSignature(body.replace("evt_1", "evt_2"), sig, secret)).toBe(false);
    expect(verifyVaaniSignature(body, `sha256=${hmacSha256Hex("other", body)}`, secret)).toBe(false);
    expect(verifyVaaniSignature(body, null, secret)).toBe(false);
    expect(verifyVaaniSignature(body, "md5=abc", secret)).toBe(false);
  });
  it("parses the envelope and defensively maps unknown data shapes", () => {
    expect(VaaniEnvelopeSchema.parse(JSON.parse(body)).id).toBe("evt_1");
    const a = normaliseCallData({ session_id: "s1", started_at: 1714003200, ended_at: 1714003500, messages: [{ speaker: "bot", content: "Hi" }, { speaker: "customer", content: "Hello" }] });
    expect(a).toMatchObject({ providerCallId: "s1", durationSeconds: 300 });
    expect(a.turns?.map((t) => t.role)).toEqual(["agent", "caller"]);
    const b = normaliseCallData({});
    expect(b).toMatchObject({ providerCallId: null, transcript: null, durationSeconds: null });
  });
});

describe("HubSpot sync (mocked API)", () => {
  const mapping: PipelineMapping = { pipelineId: "default", stages: { qualified: "s_q", consultation_booked: "s_b", consultation_completed: "s_c", deal_open: "s_p" } };
  const pipelines = { results: [{ id: "default", label: "Sales", stages: [
    { id: "s_q", label: "Qualified", displayOrder: 0, metadata: { probability: "0.1" } },
    { id: "s_b", label: "Consultation booked", displayOrder: 1, metadata: { probability: "0.2" } },
    { id: "s_c", label: "Consultation done", displayOrder: 2, metadata: { probability: "0.4" } },
    { id: "s_p", label: "Proposal", displayOrder: 3, metadata: { probability: "0.6" } },
    { id: "closedwon", label: "Won", displayOrder: 4, metadata: { probability: "1.0", isClosed: "true" } },
    { id: "closedlost", label: "Lost", displayOrder: 5, metadata: { probability: "0.0", isClosed: "true" } },
  ] }] };

  async function setup(routes: (url: string, init: RequestInit) => Response | undefined) {
    const m = memoryStore();
    const d = m.addDesigner({ hubspot_owner_id: "777" });
    const lead = await m.store.insertLead({ name: "Pooja Rao", email: "pooja@example.com", phone_normalized: "+919822012345", qualification_status: "amber", uncertainties: [{ criterion: "decision_maker", detail: "Decision-maker status not established." }], assigned_designer_id: d.id, project_type: "2BHK full home", location: "Magarpatta" });
    const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ method: init?.method ?? "GET", url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      return routes(u, init ?? {}) ?? (u.endsWith("/crm/v3/pipelines/deals") ? json(200, pipelines) : json(404, { message: "not found" }));
    }) as unknown as typeof fetch;
    return { m, lead, calls, hs: hubspotClient("pat-test", fetchImpl, { backoffMs: 1 }) };
  }

  it("matches an existing contact by email, updates it, and creates an associated deal without an amount", async () => {
    const { m, lead, calls, hs } = await setup((u, init) => {
      if (u.endsWith("/contacts/search")) return json(200, { results: [{ id: "c1", properties: { email: "pooja@example.com" } }] });
      if (u.endsWith("/contacts/c1") && init.method === "PATCH") return json(200, { id: "c1", properties: {} });
      if (u.endsWith("/deals/search")) return json(200, { results: [] });
      if (u.endsWith("/objects/deals") && init.method === "POST") return json(201, { id: "d1", properties: {} });
    });
    const r = await syncLeadToHubSpot(lead.id, { store: m.store, hs, mapping, appBaseUrl: "https://app.test" });
    expect(r).toMatchObject({ contactId: "c1", dealId: "d1", contactCreated: false, dealCreated: true, stage: "s_q" });
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/objects/deals"))!;
    const props = create.body!.properties as Record<string, unknown>;
    expect(props).toMatchObject({ pipeline: "default", dealstage: "s_q", hubspot_owner_id: "777", aangan_lead_id: lead.id, aangan_qualification_status: "amber" });
    expect(props).not.toHaveProperty("amount");
    expect(props).not.toHaveProperty("closedate");
    expect(String(props.aangan_uncertainties)).toContain("Decision-maker");
    expect(create.body!.associations).toEqual([{ to: { id: "c1" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }]);
    expect(m.leads.get(lead.id)).toMatchObject({ hubspot_contact_id: "c1", hubspot_deal_id: "d1", hubspot_sync_status: "synced" });
  });

  it("creates the contact when neither email nor phone matches", async () => {
    const { m, lead, hs } = await setup((u, init) => {
      if (u.endsWith("/search")) return json(200, { results: [] });
      if (u.endsWith("/objects/contacts") && init.method === "POST") return json(201, { id: "c9", properties: {} });
      if (u.endsWith("/objects/deals") && init.method === "POST") return json(201, { id: "d9", properties: {} });
    });
    const r = await syncLeadToHubSpot(lead.id, { store: m.store, hs, mapping, appBaseUrl: null });
    expect(r.contactCreated).toBe(true);
  });

  it("re-running uses stored ids and never moves a deal backwards or out of a closed stage", async () => {
    const { m, lead, calls, hs } = await setup((u, init) => {
      if (u.includes("/contacts/c1")) return json(200, { id: "c1", properties: {} });
      if (u.includes("/deals/d1") && init.method !== "PATCH") return json(200, { id: "d1", properties: { dealstage: "s_c", pipeline: "default", hs_is_closed: "false" } });
      if (u.includes("/deals/d1") && init.method === "PATCH") return json(200, { id: "d1", properties: {} });
    });
    await m.store.updateLead(lead.id, { hubspot_contact_id: "c1", hubspot_deal_id: "d1" });
    const r = await syncLeadToHubSpot(lead.id, { store: m.store, hs, mapping, appBaseUrl: null });
    expect(r.dealCreated).toBe(false);
    expect(calls.some((c) => c.method === "POST" && /objects\/(deals|contacts)$/.test(c.url))).toBe(false);
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/deals/d1"))!;
    expect(patch.body!.properties).not.toHaveProperty("dealstage");
  });

  it("refuses to sync without a stage mapping (setup error, not a silent skip)", async () => {
    const { m, lead, hs } = await setup(() => undefined);
    await expect(syncLeadToHubSpot(lead.id, { store: m.store, hs, mapping: null, appBaseUrl: null })).rejects.toBeInstanceOf(HubSpotSetupError);
  });

  it("refuses to sync a RED lead", async () => {
    const { m, lead, hs } = await setup(() => undefined);
    await m.store.updateLead(lead.id, { qualification_status: "red" });
    await expect(syncLeadToHubSpot(lead.id, { store: m.store, hs, mapping, appBaseUrl: null })).rejects.toThrow(/only eligible leads/);
  });

  it("surfaces missing scopes from a 403", async () => {
    const { hs } = await setup(() => json(403, { status: "error", category: "MISSING_SCOPES", message: "This app hasn't been granted all required scopes", errors: [{ context: { requiredGranularScopes: ["crm.objects.deals.write"] } }] }));
    const err = (await hs.request("GET", "/crm/v3/objects/deals?limit=1").catch((e) => e)) as HubSpotError;
    expect(err).toBeInstanceOf(HubSpotError);
    expect(err.missingScopes).toEqual(["crm.objects.deals.write"]);
    expect(err.retryable).toBe(false);
  });

  it("retries reads on 429 with backoff", async () => {
    let n = 0;
    const { hs } = await setup((u) => (u.includes("/owners") ? (++n < 3 ? json(429, { message: "slow down" }) : json(200, { results: [] })) : undefined));
    await expect(hs.owners()).resolves.toEqual([]);
    expect(n).toBe(3);
  });

  it("mirrors deals with stage probability and derives funnel events from stage progress", async () => {
    const { m, lead, hs } = await setup((u) => {
      if (u.endsWith("/deals/search"))
        return json(200, { results: [
          { id: "d1", properties: { dealname: "Pooja", amount: "1500000", pipeline: "default", dealstage: "s_p", hs_is_closed: "false", hs_is_closed_won: "false", hubspot_owner_id: "777", aangan_lead_id: null, hs_lastmodifieddate: "2026-10-10T10:00:00Z", closedate: "2026-12-15T00:00:00Z" } },
          { id: "d2", properties: { dealname: "Other", amount: null, pipeline: "default", dealstage: "closedlost", hs_is_closed: "true", hs_is_closed_won: "false", hs_lastmodifieddate: "2026-10-10T11:00:00Z" } },
        ] });
    });
    await m.store.updateLead(lead.id, { hubspot_deal_id: "d1" });
    const r = await syncDealsFromHubSpot({ store: m.store, hs, mapping });
    expect(r.fetched).toBe(2);
    expect(m.deals.get("d1")).toMatchObject({ amount: 1500000, stage_probability: 0.6, stage_label: "Proposal", lead_id: lead.id, designer_id: [...m.designers.values()][0].id });
    expect(m.deals.get("d2")).toMatchObject({ amount: null, is_closed: true, lead_id: null });
    expect(m.events.map((e) => e.event_type).sort()).toEqual(["consultation_completed", "deal_opened"]);
    expect(m.cursors.get("hubspot_deals")).toBe(String(Date.parse("2026-10-10T11:00:00Z")));
  });
});

describe("Google Calendar client (mocked API)", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const cfg = { clientId: "id", clientSecret: "secret", redirectUri: "https://app.test/cb", encryptionKey: key };
  const cred = () => ({ id: "cred-1", google_account_email: "asha@example.com", refresh_token_encrypted: encryptToken("1//refresh", key), access_token_encrypted: null, access_token_expires_at: null, scopes: [], status: "active" as const, last_error: null });

  it("refreshes the access token, stores it encrypted, and inserts events with a deterministic id", async () => {
    const m = memoryStore();
    m.creds.set("cred-1", cred());
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) return json(200, { access_token: "ya29.token", expires_in: 3600 });
      if (u.includes("/events?")) return json(200, { id: JSON.parse(String(init!.body)).id, htmlLink: "https://cal/e" });
      return json(404, {});
    }) as unknown as typeof fetch;
    const cal = googleCalendar(cred(), cfg, m.store, fetchImpl);
    const id = eventIdFor("123e4567-e89b-12d3-a456-426614174000");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    const r = await cal.insertEvent("asha@example.com", { id, summary: "s", description: "d", start: "2026-10-14T05:00:00Z", end: "2026-10-14T06:00:00Z", timezone: "Asia/Kolkata" });
    expect(r).toMatchObject({ id, alreadyExisted: false });
    const stored = m.creds.get("cred-1")!;
    expect(stored.access_token_encrypted).not.toContain("ya29");
    expect(decryptToken(stored.access_token_encrypted!, key)).toBe("ya29.token");
  });

  it("treats a 409 on retry as the same event, not a new booking", async () => {
    const m = memoryStore();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("token")) return json(200, { access_token: "ya29.t", expires_in: 3600 });
      if (init?.method === "POST") return json(409, { error: { message: "duplicate" } });
      return json(200, { id: "aangan1", status: "confirmed", htmlLink: "x" });
    }) as unknown as typeof fetch;
    const r = await googleCalendar(cred(), cfg, m.store, fetchImpl).insertEvent("c", { id: "aangan1", summary: "", description: "", start: "", end: "", timezone: "Asia/Kolkata" });
    expect(r.alreadyExisted).toBe(true);
  });

  it("marks the credential revoked on invalid_grant and refuses to claim availability", async () => {
    const m = memoryStore();
    m.creds.set("cred-1", cred());
    const fetchImpl = vi.fn(async () => json(400, { error: "invalid_grant" })) as unknown as typeof fetch;
    await expect(googleCalendar(cred(), cfg, m.store, fetchImpl).freeBusy(["c"], "a", "b")).rejects.toBeInstanceOf(GoogleAuthError);
    expect(m.creds.get("cred-1")!.status).toBe("revoked");
  });
});

describe("slot computation", () => {
  it("respects working hours, Sunday closure, holidays, buffers and designer load", () => {
    const now = new Date("2026-10-10T04:30:00Z"); // Sat 10:00 IST
    const slots = computeSlots({
      designers: [{ id: "busy", load: 5 }, { id: "free", load: 0 }],
      busy: { free: [{ start: new Date("2026-10-12T04:30:00Z"), end: new Date("2026-10-12T06:00:00Z") }] },
      config: { ...DEFAULT_BOOKING_CONFIG, holidays: ["2026-10-13"], maxOptions: 5 },
      now,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const ist = new Date(new Date(s.start).getTime() + 5.5 * 3600_000);
      expect(ist.getUTCDay()).not.toBe(0);
      expect(s.start.startsWith("2026-10-13")).toBe(false);
      expect(ist.getUTCHours()).toBeGreaterThanOrEqual(10);
      expect(ist.getUTCHours() * 60 + ist.getUTCMinutes() + 60).toBeLessThanOrEqual(19 * 60);
    }
    // Monday 10:00: the low-load designer is blocked, so the other one is offered instead;
    // once free, the low-load designer is preferred.
    expect(slots[0]).toMatchObject({ designerId: "busy", start: "2026-10-12T04:30:00.000Z" });
    expect(slots.slice(1).every((s) => s.designerId === "free")).toBe(true);
    // Monday 10:00–11:30 busy + 30 min buffer → first Monday option is 12:00 or later
    const monday = slots.filter((s) => s.start.startsWith("2026-10-12") && s.designerId === "free");
    for (const s of monday) expect(new Date(s.start).getTime()).toBeGreaterThanOrEqual(new Date("2026-10-12T06:30:00Z").getTime());
  });

  it("returns nothing rather than inventing a slot when every designer is busy", () => {
    const allDay = [{ start: new Date("2026-01-01T00:00:00Z"), end: new Date("2027-01-01T00:00:00Z") }];
    expect(computeSlots({ designers: [{ id: "a", load: 0 }], busy: { a: allDay }, config: DEFAULT_BOOKING_CONFIG, now: new Date("2026-10-10T04:30:00Z") })).toEqual([]);
  });
});

describe("Resend email", () => {
  it("sends with an Idempotency-Key and renders real appointment details only", async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: "re_123" })) as unknown as typeof fetch;
    const msg = renderConfirmationEmail({ customerName: "Pooja", startIso: "2026-10-14T05:00:00Z", endIso: "2026-10-14T06:00:00Z", timezone: "Asia/Kolkata", designerName: "Asha Kulkarni", meetingType: "site_visit", location: "Magarpatta", contactLine: null });
    expect(msg.subject).toContain("Wednesday, 14 October 2026");
    expect(msg.text).toContain("10:30 AM – 11:30 AM IST");
    expect(msg.text).toContain("Asha Kulkarni");
    expect(msg.html).not.toMatch(/\{\{|undefined|null/);
    await resendSender("re_key", "Aangan Studio <hello@aangan.example>", fetchImpl).send({ to: "p@example.com", ...msg, idempotencyKey: "confirmation-1" });
    const init = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("confirmation-1");
  });

  it("escapes customer-provided text in HTML", () => {
    const msg = renderConfirmationEmail({ customerName: "<script>x</script>", startIso: "2026-10-14T05:00:00Z", endIso: "2026-10-14T06:00:00Z", timezone: "Asia/Kolkata", designerName: null, meetingType: "studio", location: null, contactLine: null });
    expect(msg.html).not.toContain("<script>");
  });
});

describe("security helpers", () => {
  it("encrypts tokens with AES-256-GCM and detects tampering", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    const enc = encryptToken("secret-refresh-token", key);
    expect(enc).not.toContain("secret");
    expect(decryptToken(enc, key)).toBe("secret-refresh-token");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptToken(parts.join("."), key)).toThrow();
  });

  it("redacts secrets and personal data from logs", () => {
    const out = JSON.stringify(redact({ authorization: "Bearer abc", note: "key vv_live_abcdefgh123 for +91 98220 12345 and pooja@example.com", phone: "9822012345", nested: { refresh_token: "1//x" } }));
    expect(out).not.toMatch(/vv_live_abcdefgh123|98220|pooja@|Bearer abc|1\/\/x/);
  });

  it("normalises Indian phone numbers and spoken emails; masked numbers are not identifiers", () => {
    expect(normalisePhone("098220 12345")).toBe("+919822012345");
    expect(normalisePhone("+91 98220-12345")).toBe("+919822012345");
    expect(normalisePhone("+91 98XXX XX345")).toBeNull();
    expect(normaliseEmail("Pooja dot rao at gmail dot com")).toBe("pooja.rao@gmail.com");
    expect(normaliseEmail("not an email")).toBeNull();
  });
});
