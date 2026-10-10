import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";
import { SETTINGS } from "@/server/settings";
import { PipelineMappingSchema } from "@/server/services/hubspot-sync";

const SCHEMAS: Record<string, z.ZodType> = {
  ...Object.fromEntries(Object.values(SETTINGS).map((s) => [s.key, s.schema])),
  hubspot_pipeline: PipelineMappingSchema,
};

const Body = z.object({ key: z.string(), value: z.unknown() });

/** Versioned, audited configuration changes (qualification rules, booking, policies, mappings). */
export const PUT = handle("admin.settings", async (req: Request) => {
  const user = await requireRole("admin");
  const { key, value } = await readJson(req, (v) => Body.parse(v));
  const schema = SCHEMAS[key];
  if (!schema) throw new HttpError(400, "Unknown setting", "unknown_setting");
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, `Invalid value: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, "invalid_value");
  const db = createAdminClient();
  const { data: before } = await db.from("app_settings").select("value, version").eq("key", key).maybeSingle();
  const { error } = await db.from("app_settings").upsert({ key, value: parsed.data, version: (before?.version ?? 0) + 1, updated_by: actorId(user), updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  await store().audit({ actor_id: actorId(user), action: "settings.update", entity_type: "app_setting", entity_id: key, before: before?.value ?? null, after: parsed.data });
  return NextResponse.json({ ok: true, version: (before?.version ?? 0) + 1 });
});
