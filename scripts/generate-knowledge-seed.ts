/**
 * Writes supabase/migrations/20261010000004_seed_knowledge.sql from src/domain/knowledge/seed.ts.
 * Run: npm run knowledge:seed-sql. A test fails if the migration drifts from the TS source.
 */
import { writeFileSync } from "node:fs";
import { buildKnowledgeSeedSql } from "../src/domain/knowledge/seed-sql";

writeFileSync(new URL("../supabase/migrations/20261010000004_seed_knowledge.sql", import.meta.url), buildKnowledgeSeedSql());
console.log("knowledge seed migration written");
