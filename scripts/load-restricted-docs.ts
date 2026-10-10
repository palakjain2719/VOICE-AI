/**
 * Loads business-source/restricted/pricing.md (git-ignored) into the admin-only
 * restricted_documents table. Never imported by application code.
 * Run: npm run restricted:load   (needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
const body = readFileSync(new URL("../business-source/restricted/pricing.md", import.meta.url), "utf8");
const db = createClient(url, key, { auth: { persistSession: false }, db: { schema: process.env.SUPABASE_DB_SCHEMA || "aangan" } });
async function main() {
  const { error } = await db.from("restricted_documents").upsert({ slug: "internal-pricing-guide", title: "Internal pricing guide (indicative, never quoted)", body });
  if (error) throw new Error(error.message);
  console.log("restricted pricing guide loaded");
}
main();
