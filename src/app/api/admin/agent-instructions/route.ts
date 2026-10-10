import { handle } from "@/server/http";
import { requireRole } from "@/server/auth";
import { env } from "@/lib/env";
import { store } from "@/server/store/supabase-store";
import { buildAgentInstructions } from "@/domain/knowledge/agent-instructions";

/** Current agent instructions generated from published knowledge, for pasting into the Vaani flow. */
export const GET = handle("admin.agent_instructions", async () => {
  await requireRole("admin");
  const text = buildAgentInstructions(await store().listPublishedArticles(), { toolsBaseUrl: env().APP_BASE_URL ?? null });
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
});
