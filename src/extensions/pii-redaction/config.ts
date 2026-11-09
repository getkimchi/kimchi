/**
 * Redaction configuration reader.
 *
 * Enablement is governed by the resources system: the org policy's
 * kimchiResources entry (ON/OFF soft defaults, FORCE_ON/FORCE_OFF locks),
 * the user's persistent /resources override, the transient
 * KIMCHI_ENABLE_RESOURCES env, and the definition default (off).
 *
 * WHAT redacts is governed by the `redaction` block of the same
 * settings.json — two mutually exclusive shapes:
 *
 *   Legacy (unchanged semantics):
 *     { "redaction": { "excludedEntities": ["DATE_TIME", "PHONE_NUMBER"] } }
 *     A present array REPLACES the tier-registry default wholesale, unknown
 *     entity names throw. It can switch bare detectors back on — the only
 *     way to do so for anchor-required entities.
 *
 *   Policy (LLM-4416):
 *     { "redaction": {
 *         "categories": { "network": "off" },
 *         "entities": { "PHONE_NUMBER": "on" },
 *         "customEntities": [{ "name": "ACME_ID", "category": "identity_documents",
 *                              "pattern": "…", "flags"?, "secretGroup"? }] } }
 *     Entity states beat category states; "on" never enables an
 *     anchor-required entity's bare engine detector (its anchored patterns
 *     simply run). Unknown categories/entities or invalid custom entries
 *     throw. Mixing the policy keys with legacy `excludedEntities` throws.
 *
 * An absent `redaction` block (or an empty one) resolves to the tier
 * defaults byte-for-byte; the org-managed policy (settings:resolve
 * `kimchiRedaction`) takes precedence over the local block per key
 * (managed → local → registry default); see `policy.ts` for the resolution
 * contract and `.kimchi/plans/redaction-precision.md` for compatibility
 * notes. Consumers split by failure policy: the strict export path lets a
 * validation error propagate (fail closed), while the redactor's snapshot
 * resolution degrades to the tier defaults with one loud log so a settings
 * typo can never silently switch the live pipeline's redaction off.
 *
 * Reads go through the stat-gated JSON cache shared with the resources
 * store, so per-event consultation is cheap and mid-session edits are
 * picked up without a restart (the redactor engine rebuilds when the
 * resolved view's signature changes). With an org FORCE_* lock in force the
 * settings file is not read at all — a locked deployment cannot be broken
 * by a corrupt local file.
 *
 * The module is a thin seam by design: it is the one place that names the
 * redaction gate for consumers outside this extension's hooks
 * (work-attribution/semantic.ts, ferment-v2/evaluator.ts), and the single
 * mock point for their tests.
 */

import { readJsonCached } from "../../config/json.js"
import { getOrgPolicy } from "../../org-policy.js"
import { getResourceSettingsPath, isResourceEnabled, isResourceLocked } from "../../resources/store.js"
import {
	type LocalRedactionInput,
	parseLegacyExcludedEntities,
	parseLocalPolicy,
	parseManagedPolicy,
	type RedactionPolicy,
	type ResolvedRedaction,
	resolveRedactionPolicy,
} from "./policy.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"

/** Keys the local `redaction` settings section understands; anything else throws (fail-visible). */
const KNOWN_REDACTION_KEYS = new Set(["renderMode", "excludedEntities", "categories", "entities", "customEntities"])

/**
 * How engine detections are rendered in stored output:
 * - `tokens` (default): `[<ENTITY>_N]` — stable per-session reversible
 *   tokens; originals resolve only at presentation (see
 *   docs/pii-redaction-tokens.md and vault.ts)
 * - `markers`: `[REDACTED-<ENTITY>]` — opt-in flat markers (settings or
 *   degrade fallback), the historical shape
 *
 * Local opt-in via settings.json `redaction.renderMode`; org-locked
 * deployments follow the same tokens default (the org lock pins the
 * resource, never the presentation).
 */
export type RedactionRenderMode = "markers" | "tokens"

export interface RedactionConfig {
	/** Whether PII/secret redaction is active. */
	enabled: boolean
	/** Detection rendering mode (default `tokens`). */
	renderMode: RedactionRenderMode
	/** The executable view: engine exclusions, disabled coverage, user patterns. */
	resolved: ResolvedRedaction
}

/**
 * Non-throwing enablement gate for the extension hooks. The hooks need only
 * `enabled`, which never depends on the `redaction` settings block whose
 * validation can throw — a typo'd block must not turn the gate into a
 * rejection the extension runner discards (that would store and send
 * unredacted content with only a per-event log). Exclusion degrade
 * semantics live in the redactor's snapshot resolution; a fully malformed
 * settings.json still fails visibly per the readJson convention.
 */
export function isRedactionEnabled(): boolean {
	return isResourceEnabled(PII_REDACTION_RESOURCE_ID)
}

/**
 * Non-throwing render-mode read for vault lifecycle gating (session_start
 * may not throw). An invalid settings block degrades to `markers` here;
 * the loud-log and strict-fail paths live in the redactor's snapshot
 * resolution and the export walk.
 */
export function getRedactionRenderMode(): RedactionRenderMode {
	try {
		return getRedactionConfig().renderMode
	} catch {
		return "markers"
	}
}

/**
 * The org-managed redaction policy, carried as the raw kimchiRedaction wire
 * value on OrgPolicy and normalized here by the tolerant parser: unknown
 * categories/entities and invalid custom entries drop with one loud log —
 * a platform value this harness predates must never switch redaction off
 * silently (and the strict export path never fails closed on managed input:
 * the operator did not write it and cannot fix it).
 */
// The org-policy redaction object is parsed on EVERY redacted event via
// getRedactionConfig; identity-memoize it so a wire value that changed
// nothing re-parses zero work and the drop-log fires once per distinct
// wire value, not once per event.
const managedParseMemo = new WeakMap<object, RedactionPolicy | undefined>()

/**
 * The organization's own keyset, resolved on its own — exported so the
 * snapshot's degrade path can keep the org's rules live even when a
 * malformed LOCAL settings.json crashed the full resolution: the org did
 * not write the local file and its policy must not fall off because of
 * someone else's typo.
 */
export function getManagedRedactionPolicy(): RedactionPolicy | undefined {
	const raw = getOrgPolicy()?.redaction
	if (raw === undefined) return undefined
	if (managedParseMemo.has(raw as object)) return managedParseMemo.get(raw as object)
	const parsed = parseManagedPolicy(raw, (reasons) => {
		console.error(`[pii-redaction] dropped ${reasons.length} unrecognized org redaction entries: ${reasons.join("; ")}`)
	})
	try {
		managedParseMemo.set(raw as object, parsed)
	} catch {
		// Primitive wire values cannot key a WeakMap — rare and bounded; skip.
	}
	return parsed
}

/** Read the current config: resources-system enablement + resolved policy + render mode. */
export function getRedactionConfig(): RedactionConfig {
	const managed = getManagedRedactionPolicy()
	// Lock short-circuit mirrors the resources store: under FORCE_* the
	// settings file is never opened — only the managed policy applies; the
	// presentation follows the tokens default (the org lock pins the
	// resource, never the presentation).
	if (isResourceLocked(PII_REDACTION_RESOURCE_ID)) {
		return {
			enabled: isResourceEnabled(PII_REDACTION_RESOURCE_ID),
			renderMode: "tokens",
			resolved: resolveRedactionPolicy(managed),
		}
	}
	return {
		enabled: isResourceEnabled(PII_REDACTION_RESOURCE_ID),
		renderMode: readRenderModeSetting() ?? "tokens",
		resolved: resolveRedactionPolicy(managed, readLocalRedactionInput(managed)),
	}
}

/**
 * Read + validate the local settings.json `redaction` block. Returns
 * undefined when the block is absent or empty (defaults apply). Malformed
 * JSON propagates through readJsonCached (fail-visible); invalid blocks
 * throw for the same reason — either way the operator learns their settings
 * file is wrong instead of running with silently different redaction
 * behavior than they wrote down.
 */
function readLocalRedactionInput(managed?: RedactionPolicy): LocalRedactionInput | undefined {
	const settings = readJsonCached(getResourceSettingsPath())
	const redaction = settings.redaction
	if (redaction === undefined) return undefined
	if (redaction === null || typeof redaction !== "object" || Array.isArray(redaction)) {
		throw new Error('settings.json "redaction" must be an object')
	}
	const block = redaction as Record<string, unknown>
	// Unknown keys throw: the whole-message-replace model lets the platform
	// add keys later, but a local settings typo must fail visibly — the
	// operator wrote it and can fix it.
	for (const key of Object.keys(block)) {
		if (!KNOWN_REDACTION_KEYS.has(key)) {
			throw new Error(`settings.json "redaction": unknown property "${key}"`)
		}
	}
	const legacyRaw = block.excludedEntities
	const hasPolicyKeys =
		block.categories !== undefined || block.entities !== undefined || block.customEntities !== undefined
	if (legacyRaw !== undefined && hasPolicyKeys) {
		throw new Error(
			'settings.json "redaction": "excludedEntities" cannot be combined with categories/entities/customEntities',
		)
	}
	if (legacyRaw !== undefined) return { legacyExcluded: parseLegacyExcludedEntities(legacyRaw) }
	if (!hasPolicyKeys) return undefined
	// Custom entities defined by the org are valid local `entities` keys:
	// resolution merges the two custom-def layers, so the toggle must parse.
	const managedCustomNames = new Set((managed?.customEntities ?? []).map((c) => c.name))
	return parseLocalPolicy(block, managedCustomNames)
}

/**
 * Read + validate settings.json `redaction.renderMode`. Returns undefined
 * when the key is absent (tokens default). Same fail-visible convention as
 * the entity list: a typo throws so the operator learns the setting is
 * wrong; consumers degrade to markers per their failure policy (strict
 * export fails closed; hooks degrade with one loud log).
 */
function readRenderModeSetting(): RedactionRenderMode | undefined {
	const settings = readJsonCached(getResourceSettingsPath())
	const redaction = settings.redaction
	if (redaction === undefined) return undefined
	if (redaction === null || typeof redaction !== "object" || Array.isArray(redaction)) {
		throw new Error('settings.json "redaction" must be an object')
	}
	const raw = (redaction as Record<string, unknown>).renderMode
	if (raw === undefined) return undefined
	if (raw !== "markers" && raw !== "tokens") {
		throw new Error('settings.json "redaction.renderMode" must be "markers" or "tokens"')
	}
	return raw
}
