import { isResourceEnabled } from "../../resources/store.js"
import { FERMENT_LEGACY_RESOURCE_ID } from "./resource-id.js"

// Re-export the pure id constants so existing importers of resource.js keep
// working. They live in resource-id.js to break the definitions/store cycle.
export { FERMENT_LEGACY_COMMAND_NAME, FERMENT_LEGACY_RESOURCE_ID } from "./resource-id.js"

/** Legacy entry points call this so V1 stays inert unless the user opted in. */
export function isFermentLegacyEnabled(): boolean {
	return isResourceEnabled(FERMENT_LEGACY_RESOURCE_ID)
}
