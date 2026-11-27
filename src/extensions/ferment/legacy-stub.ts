import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isAcpSessionHost } from "../../modes/acp/state.js"
import { notifyUser } from "../../utils/notify-user.js"
import fermentExtension from "./index.js"
import { fermentLegacyNotLoadedMessage, isFermentLegacyEnabled } from "./resource.js"
import { FERMENT_LEGACY_COMMAND_NAME } from "./resource-id.js"

/**
 * Registered instead of V1 when legacy Ferment did not load at startup.
 * Without it, `/ferment-legacy list` has no command and goes to the model as
 * a normal prompt, which may then act on `.kimchi/ferments` by itself.
 */
export function fermentLegacyStubExtension(pi: ExtensionAPI): void {
	// Legacy Ferment is not supported over ACP, so ACP has no /ferment-legacy at all.
	if (isAcpSessionHost()) return
	pi.registerCommand(FERMENT_LEGACY_COMMAND_NAME, {
		description: "Legacy Ferment (V1) is not loaded. Run it to see how to turn it on.",
		// Arguments are ignored: the fix is the same whatever V1 command the user meant.
		async handler(_args, ctx) {
			notifyUser(ctx, fermentLegacyNotLoadedMessage(`/${FERMENT_LEGACY_COMMAND_NAME}`), "warning")
		},
	})
}

/**
 * Exactly one of V1 and the stub owns `/ferment-legacy`. V1 loads only when
 * legacy is on at startup, the same gate as the legacy CLI flags.
 */
export function selectFermentLegacyExtension(): (pi: ExtensionAPI) => void {
	return isFermentLegacyEnabled() ? fermentExtension : fermentLegacyStubExtension
}
