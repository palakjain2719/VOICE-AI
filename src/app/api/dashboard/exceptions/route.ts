import { NextResponse, type NextRequest } from "next/server";
import { handle } from "@/server/http";
import { requireRole } from "@/server/auth";
import { createDataClient } from "@/lib/supabase/server";

export const GET = handle("dashboard.exceptions", async (req: NextRequest) => {
  await requireRole("founder", "operator");
  const sp = req.nextUrl.searchParams;
  const db = await createDataClient();
  let q = db.from("exceptions").select("id, kind, status, severity, title, created_at, due_at, owner_id, call_id, lead_id, retryable").eq("is_test", false).order("created_at", { ascending: false }).limit(200);
  const kind = sp.get("kind");
  const status = sp.get("status");
  if (kind) q = q.eq("kind", kind);
  q = status ? q.eq("status", status) : q.in("status", ["open", "in_review"]);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return NextResponse.json({ items: data });
});
