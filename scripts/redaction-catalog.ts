#!/usr/bin/env bun
/**
 * Print the redaction entity catalog as JSON: every configurable entity
 * with its tier, category, effective default (redacts today or not), and
 * liveState (engine-side disposition: active / no_matcher — alias_of is
 * reserved, no current aliases).
 *
 * Consumers: the output is committed next to the registry
 * (src/extensions/pii-redaction/redaction-catalog.json, pinned by a
 * drift-guard test) and the policy-UI console fetches the tagged raw file
 * from the public repo to regenerate its constants; the harness never
 * serves it at runtime.
 *
 * Usage:
 *   bun scripts/redaction-catalog.ts
 *
 * Output is tab-indented to match the repo's biome JSON format, so raw
 * output is byte-identical to the committed file:
 *   bun scripts/redaction-catalog.ts > src/extensions/pii-redaction/redaction-catalog.json
 *
 * Dev tooling (not shipped in the binary): run directly with bun.
 */
import { listRedactionCatalog } from "../src/extensions/pii-redaction/entity-tiers.js"

// Only actionable rows publish. no_matcher rows (anchor_required entities
// without an anchored custom — none today) would be dead toggles for
// consumers; names in PERMANENT_ENGINE_EXCLUSIONS never reach the catalog
// at all — no registry entry, suppressed engine-side on every path. The
// filter stays as the guard: a future anchor_required addition without a
// custom auto-classifies as no_matcher and stays out of the published
// contract.
const published = listRedactionCatalog().filter((entry) => entry.liveState === "active")

console.log(JSON.stringify(published, null, "\t"))
