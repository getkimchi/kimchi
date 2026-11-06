/**
 * Extracts the comma-separated tool-name line from the `## Available Tools`
 * section of a rendered system prompt, or throws when the section is absent.
 * Test-only — keeps the section's exact separator format in one place so a
 * formatting change to the tools section cannot silently break visibility /
 * tool-presence assertions across modules.
 */
export function toolNamesFromSection(systemPrompt: string): string {
	const after = systemPrompt.split("## Available Tools\n\n")[1]
	if (after === undefined) throw new Error("## Available Tools section missing from system prompt")
	return after.split("\n")[0]
}

/**
 * Register `handler` under `event` in a test harness's handler map,
 * composing with any earlier registration for the same event. Test-only —
 * the real extension runner invokes EVERY handler registered for an event,
 * so a plain `Map.set` would shadow earlier listeners once an event gains a
 * second one (e.g. `agent_start`, `session_shutdown`) and tests would
 * silently exercise only the last registration.
 */
export function composeHandlerRegistration(
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>,
	event: string,
	handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
): void {
	const previous = handlers.get(event)
	handlers.set(
		event,
		previous
			? async (composedEvent: unknown, composedCtx: unknown) => {
					const first = await previous(composedEvent, composedCtx)
					const second = await handler(composedEvent, composedCtx)
					return second ?? first
				}
			: handler,
	)
}
