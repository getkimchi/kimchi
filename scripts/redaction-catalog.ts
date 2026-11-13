#!/usr/bin/env bun
/**
 * Print the redaction entity catalog as JSON: every configurable entity
 * with its tier, category, effective default (redacts today or not), and
 * liveState (engine-side disposition: active / no_matcher — alias_of is
 * reserved, no current aliases).
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

// Only actionable rows publish. no_matcher rows (anchor_required entities
// without an anchored custom — none today) would be dead toggles for
// consumers; removed names (URL family, CRATES_IO_TOKEN, NUGET_KEY,
// UK_POSTCODE) never reach the catalog at all — they left the registry and
// are suppressed engine-side via PERMANENT_ENGINE_EXCLUSIONS. The filter
// stays as the guard: a future anchor_required addition without a custom
// auto-classifies as no_matcher and stays out of the published contract.
const published = listRedactionCatalog().filter((entry) => entry.liveState === "active")

console.log(JSON.stringify(published, null, 2))
