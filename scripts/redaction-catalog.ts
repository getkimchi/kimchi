#!/usr/bin/env bun
/**
 * Print the redaction entity catalog as JSON: every configurable entity
 * with its tier, category, effective default (redacts today or not), and
 * liveState (engine-side disposition: active / alias_of / no_matcher).
 *
 * Consumers: the release workflow attaches this output to the GitHub
 * release as redaction-catalog.json (the ai-enabler-console fetch script
 * regenerates its constants from that asset); the harness never serves it
 * at runtime.
 *
 * Usage:
 *   bun scripts/redaction-catalog.ts
 *
 * Dev tooling (not shipped in the binary): run directly with bun.
 */
import { listRedactionCatalog } from "../src/extensions/pii-redaction/entity-tiers.js"

// Only actionable rows publish. no_matcher and alias entities stay in
// the harness registry (engine-vocabulary drift tests, settings-key
// validation) but not in the published catalog:
// - no_matcher (CRATES_IO_TOKEN, NUGET_KEY): nothing fires under any
//   policy; a consumer-visible row is a dead toggle.
// - alias_of (URL, MONGODB_SRV, ELASTICSEARCH_URL, FIREBASE_URL): their
//   credentialed coverage reports under URL_WITH_CREDENTIALS (published),
//   and post-#1699 policy semantics cannot activate their bare shapes —
//   anchor_required ON means "anchored customs run", and none exist under
//   those names — so their toggles are dead too. Their coverage story
//   belongs on the URL_WITH_CREDENTIALS row, not as phantom entities.
const published = listRedactionCatalog().filter((entry) => entry.liveState === "active")

console.log(JSON.stringify(published, null, 2))
