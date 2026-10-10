/**
 * Creates the Aangan property group + custom properties (additive, skips existing) and prints the
 * deal pipelines and owners so stages can be mapped. npm run hubspot:setup
 */
import { hubspotClient } from "../src/integrations/hubspot/client";
import { ensureProperties, probeScopes } from "../src/integrations/hubspot/properties";

async function main() {
  const hs = hubspotClient(process.env.HUBSPOT_SERVICE_KEY!);
  const r = await ensureProperties(hs);
  console.log(`properties: ${r.created.length} created, ${r.existing.length} already existed`);
  for (const c of await probeScopes(hs)) console.log(`${c.ok ? "✓" : "✗"} ${c.check}${c.missingScopes?.length ? ` missing ${c.missingScopes.join(", ")}` : ""}`);
  for (const p of await hs.pipelines()) {
    console.log(`\npipeline ${p.id} "${p.label}"`);
    for (const s of [...p.stages].sort((a, b) => a.displayOrder - b.displayOrder)) console.log(`  ${s.displayOrder}. ${s.id}  "${s.label}"  p=${s.metadata.probability ?? "-"}${s.metadata.isClosed === "true" ? " (closed)" : ""}`);
  }
  console.log(`\nowners: ${(await hs.owners()).length}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
