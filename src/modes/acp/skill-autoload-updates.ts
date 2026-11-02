// Mirror the skills-manager auto-loader's `skill_autoload_loaded` entries to
// ACP clients as a `_kimchi.dev/skill_autoload` ext notification, so IDE
// clients can surface "skill auto-loaded" the way the TUI transcript entry
// does (the steer itself is display:false by design — the body is far too
// large to render). One notification per first injection: the loader's
// one-shot-per-session semantics mean each appended entry is a real load.
// Fire-and-forget, like emitRoutedModelUpdate: a failed or unsupported ext
// notification must never disturb the turn. Payload keys are built
// explicitly (never spread from entry data) so a future entry field can
// never clobber `sessionId`. The matched trigger stays off the wire on
// purpose — the user-facing line is the skill name, not the keyword.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { SKILL_AUTOLOAD_LOADED_TYPE, type SkillAutoLoadData } from "../../extensions/skills-manager/auto-load.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitExtNotification } from "./ext-notifications.js"

export function emitSkillAutoloadUpdate(conn: AgentSideConnection, sessionId: string, event: AgentSessionEvent): void {
	if (event.type !== "entry_appended") return
	const entry = event.entry as { type?: unknown; customType?: unknown; data?: unknown }
	if (entry.type !== "custom" || entry.customType !== SKILL_AUTOLOAD_LOADED_TYPE) return
	const data = entry.data as Partial<SkillAutoLoadData> | undefined
	if (typeof data?.name !== "string") return
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.skill_autoload, {
		sessionId,
		name: data.name,
		origin: data.origin,
	})
}
