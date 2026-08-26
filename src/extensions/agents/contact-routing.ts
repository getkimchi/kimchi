/**
 * Subagent user-audience routing — who a child's user-addressed message
 * reaches right now.
 *
 * The audience policy is the ordered `USER_CONTACT_ROUTES` table: the first
 * route that returns a contact wins. Change priority by reordering entries;
 * add an audience by inserting a route before the terminal `unavailable`
 * route. Session liveness and root binding are preconditions enforced by the
 * caller (`src/extensions/agents/index.ts`), not routes.
 */

import type { AgentContact } from "./message-tool.js"

/** Live environment the routes read — nothing cached, everything resolvable
 *  at call time. */
export interface UserContactEnv {
	hasUI: boolean
	/** Present when the session is autonomous AND a judge can stand in for the
	 *  user (see `src/extensions/ferment/autonomy.ts`). */
	judgeRoute?: { fermentId: string }
}

/** One audience candidate. Return the contact when this route applies, or
 *  undefined to fall through to the next route. */
export type UserContactRoute = (env: UserContactEnv) => AgentContact | undefined

const judgeAudience: UserContactRoute = (env) =>
	env.judgeRoute ? { reachable: true, route: "ferment_judge", ferment_id: env.judgeRoute.fermentId } : undefined

const interactiveQuestionnaire: UserContactRoute = (env) =>
	env.hasUI ? { reachable: true, route: "questionnaire" } : undefined

/** Terminal route — resolution must never fail. Hands the child the
 *  blocked-report escape hatch instead of an audience. Must stay last. */
const unavailableAudience: UserContactRoute = () => ({
	reachable: false,
	route: "unavailable",
	reason: "No live questionnaire or autonomous Ferment judge route is available.",
})

/** Ordered audience routes: first match wins. `unavailableAudience` is
 *  terminal and must remain the last entry. */
export const USER_CONTACT_ROUTES: readonly UserContactRoute[] = [
	judgeAudience,
	interactiveQuestionnaire,
	unavailableAudience,
]

/** Resolve who a subagent user-addressed message reaches right now. */
export function resolveUserContact(env: UserContactEnv): AgentContact {
	for (const route of USER_CONTACT_ROUTES) {
		const contact = route(env)
		if (contact) return contact
	}
	throw new Error("USER_CONTACT_ROUTES must end with a terminal route that always resolves")
}
