import type { Store } from "@/server/store/types";

export type Decision = "approve" | "reject" | "route_admin" | "route_callback" | "route_designer";

/**
 * Human decisions from the review queue / front desk.
 *  - approve: the enquiry is qualified by a person (recorded as such), goes to HubSpot, and a
 *    "book the consultation" callback lands with the front desk.
 *  - reject:  the enquiry is declined; a polite closing email is queued when an email exists.
 *  - route_*: moves the item to another lane (designer / admin / callback).
 * Every decision is written to the exception and the audit log.
 */
export async function decideException(store: Store, input: { exceptionId: string; decision: Decision; actorId: string | null; note?: string | null }) {
  const ex = await store.getException(input.exceptionId);
  if (!ex) throw new Error("Exception not found");
  if (ex.status === "resolved" || ex.status === "dismissed") throw new Error("Already closed");
  const now = new Date().toISOString();
  const note = input.note?.trim() || null;

  if (input.decision.startsWith("route_")) {
    const lane = input.decision.replace("route_", "") as "admin" | "callback" | "designer";
    await store.updateException(ex.id, { lane, status: "open", decision: `routed_${lane}` });
    await store.audit({ actor_id: input.actorId, action: `review.${input.decision}`, entity_type: "exception", entity_id: ex.id, before: { lane: ex.lane }, after: { lane, note } });
    return { outcome: `routed to ${lane}` };
  }

  const lead = ex.lead_id ? await store.getLead(ex.lead_id) : null;
  if (input.decision === "approve") {
    if (lead) {
      await store.insertQualification({
        call_id: lead.last_call_id,
        lead_id: lead.id,
        status: "amber",
        criteria: {},
        reasons: [`Approved by a person${note ? `: ${note}` : ""}`],
        uncertainties: lead.uncertainties ?? [],
        facts: {},
        rules_version: "human",
        config_hash: "human",
        evaluated_by: `human:${input.actorId ?? "studio-access"}`,
      });
      await store.updateLead(lead.id, { qualification_status: "amber", hubspot_sync_status: "pending", decline_category: null });
      await store.addLeadEvent({ lead_id: lead.id, call_id: lead.last_call_id, event_type: "qualified", dedupe_key: `lead:${lead.id}`, metadata: { by: "human" }, is_test: lead.is_test });
      if (!lead.is_test) await store.enqueueJob("hubspot_sync_lead", { lead_id: lead.id, reason: "approved" }, `hubspot:${lead.id}:approved`);
      if (!(await store.getLiveAppointmentForLead(lead.id))) {
        await store.upsertException({
          kind: "booking_not_completed", lane: "callback", severity: "high", lead_id: lead.id, call_id: lead.last_call_id, dedupe_key: `no-booking:${lead.id}`, is_test: lead.is_test,
          title: `Book consultation: ${lead.name ?? "caller"}${lead.locality ? `, ${lead.locality}` : ""}`,
          detail: "Approved after review. Call the customer to book a consultation.",
        });
      }
    }
    await store.updateException(ex.id, { status: "resolved", decision: "approved", resolution: note ?? "Approved", resolved_by: input.actorId, resolved_at: now });
  } else {
    if (lead) {
      await store.updateLead(lead.id, { qualification_status: "red", decline_category: lead.decline_category ?? "category" });
      await store.addLeadEvent({ lead_id: lead.id, call_id: lead.last_call_id, event_type: "rejected", dedupe_key: `lead:${lead.id}`, metadata: { by: "human", note }, is_test: lead.is_test });
      if (lead.email && !lead.is_test) await store.enqueueJob("send_closure_email", { lead_id: lead.id, slug: "closure-multiple" }, `closure:${lead.id}`);
    }
    await store.updateException(ex.id, { status: "dismissed", decision: "rejected", resolution: note ?? "Declined", resolved_by: input.actorId, resolved_at: now });
  }
  await store.audit({ actor_id: input.actorId, action: `review.${input.decision}`, entity_type: "exception", entity_id: ex.id, after: { lead_id: lead?.id ?? null, note } });
  return { outcome: input.decision === "approve" ? "approved" : "declined" };
}
