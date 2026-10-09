// ACP extension method handlers for feature-level resource control.
//
// Wire names: `_kimchi.dev/list_resources` and
// `_kimchi.dev/set_resource_enabled` — the vendor-namespaced methods exposing
// the /resources machinery (any Kimchi resource: hooks, tools, extensions,
// plugins) to ACP clients that build their own settings UI. Advertised via
// _meta["kimchi.dev"]. Sessionless on purpose: resource overrides are
// per-machine settings, not session-scoped state.
//
// Concurrency note: set_resource_enabled writes the harness settings through
// the resources store's read-modify-write helper (temp file + atomic rename).
// There is no cross-process lock, so two simultaneous writes can lose a
// neighbouring settings key — the same trade the store already makes for the
// /resources command and set_onboarding_flag.

import { RequestError } from "@agentclientprotocol/sdk"
import { getResourceDefinition, getResourceDefinitions } from "../../../resources/definitions.js"
import { getResourceOverride, isResourceEnabled, setResourceOverride } from "../../../resources/store.js"

/**
 * Config locations the handlers target. Only the harness settings override is
 * needed for tests; production always writes the user's settings.json.
 */
export type ResourceMethodPaths = {
	/** Harness settings path override; defaults to the user's settings.json. */
	settingsPath?: string
}

/**
 * Handler for the `_kimchi.dev/list_resources` ACP extension method.
 *
 * Read-only snapshot of every known resource with its effective enabled
 * state, its default, and whether a persistent override exists — everything
 * an IDE needs to render a toggle list. The enabled value comes from the
 * store's full precedence (override → env → default), so it matches what the
 * running process actually consults.
 */
export function handleListResources(paths: ResourceMethodPaths = {}): Record<string, unknown> {
	const resources = getResourceDefinitions().map((resource) => ({
		id: resource.id,
		kind: resource.kind,
		label: resource.label,
		description: resource.description,
		enabled: isResourceEnabled(resource.id, paths.settingsPath),
		defaultEnabled: resource.defaultEnabled,
		restartRequired: resource.restartRequired,
		experimental: resource.experimental === true,
		overridden: getResourceOverride(resource.id, paths.settingsPath) !== undefined,
	}))
	return { resources }
}

/**
 * Handler for the `_kimchi.dev/set_resource_enabled` ACP extension method.
 *
 * Persists a resource override (the same write the /resources command makes).
 * Returns `restartRequired` from the definition so the client can surface
 * the restart hint. Unknown-but-well-formed ids are rejected: an inert
 * override the /resources UI never shows is a silent failure mode.
 *
 * @throws RequestError.invalidParams when `resourceId`/`enabled` are missing
 *   or mistyped, or the id names no known resource.
 * @throws RequestError.internalError when the settings write fails
 *   (e.g. EACCES, ENOSPC), so the client can tell a persistence failure
 *   apart from a params rejection.
 */
export function handleSetResourceEnabled(
	paths: ResourceMethodPaths = {},
	params: Record<string, unknown> = {},
): Record<string, unknown> {
	// Resolved outside the try/catch on purpose: invalidParams must surface as
	// -32602, not be re-wrapped into the write-failure internalError below
	// (the set-onboarding-flag precedent).
	const { id, enabled } = resolveSetResourceParams(params)
	try {
		setResourceOverride(id, enabled, paths.settingsPath)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw RequestError.internalError(undefined, `Failed to persist resource override: ${detail}`)
	}
	return { id, enabled, restartRequired: getResourceDefinition(id)?.restartRequired === true }
}

function resolveSetResourceParams(params: Record<string, unknown>): { id: string; enabled: boolean } {
	const id = params.resourceId
	if (typeof id !== "string" || id.length === 0) {
		throw RequestError.invalidParams(undefined, "resourceId is required and must be a non-empty string")
	}
	const enabled = params.enabled
	if (typeof enabled !== "boolean") {
		throw RequestError.invalidParams(undefined, "enabled is required and must be a boolean")
	}
	if (!getResourceDefinition(id)) {
		throw RequestError.invalidParams(undefined, `unknown resourceId ${id} — see list_resources`)
	}
	return { id, enabled }
}
