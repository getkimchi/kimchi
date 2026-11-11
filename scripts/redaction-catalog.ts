#!/usr/bin/env bun
/**
 * Print the redaction entity catalog as JSON: every configurable entity
 * with its tier, category, and effective default (redacts today or not).
 *
 * Consumers: the ai-enabler-console copies this output into its generated
 * redactionCatalog constant (see its header for the regenerate step); the
 * harness never serves it at runtime.
 *
 * Usage:
 *   bun scripts/redaction-catalog.ts
 *
 * Dev tooling (not shipped in the binary): run directly with bun.
 */
import { listRedactionCatalog } from "../src/extensions/pii-redaction/entity-tiers.js"

console.log(JSON.stringify(listRedactionCatalog(), null, 2))
