import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { withCommandReplyScope } from "../../shared/command-reply-scope.js"
import { notifyUser } from "../../utils/notify-user.js"
import { fermentNotLoadedMessage } from "./availability.js"
import { FERMENT_V2_COMMAND_NAME, FERMENT_V2_RESOURCE_ID } from "./constants.js"
import fermentV2Extension from "./index.js"

/**
 * Registered instead of Ferment when it did not load at startup. Without it,
 * `/ferment refactor auth` has no command and goes to the model as a normal
 * prompt.
 */
export function fermentStubExtension(pi: ExtensionAPI): void {
	pi.registerCommand(FERMENT_V2_COMMAND_NAME, {
		description: "Ferment is not loaded. Run it to see how to turn it on.",
		// Arguments are ignored: the fix is the same whatever the user meant.
		// The scope makes ACP also send the reply as agent text. Plain clients
		// ignore pi_notify, so they would see nothing.
		async handler(_args, ctx) {
			await withCommandReplyScope(ctx.sessionManager.getSessionId(), async () => {
				notifyUser(ctx, fermentNotLoadedMessage(`/${FERMENT_V2_COMMAND_NAME}`), "warning")
			})
		},
	})
}

/**
 * Exactly one of Ferment and the stub owns `/ferment`. Ferment loads only
 * when its resource is on at startup.
 */
export function selectFermentExtension(): (pi: ExtensionAPI) => void {
	return isResourceEnabled(FERMENT_V2_RESOURCE_ID) ? fermentV2Extension : fermentStubExtension
}
