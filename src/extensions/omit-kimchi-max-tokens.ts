import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

function isKimchiProvider(provider: string): boolean {
	return provider === "kimchi-dev" || provider.startsWith("kimchi-dev/") || provider === "kimchi-experimental"
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function omitKimchiMaxTokensFromPayload(payload: unknown, provider: string): unknown {
	if (!isKimchiProvider(provider) || !isRecord(payload)) return payload
	if (!("max_completion_tokens" in payload) && !("max_tokens" in payload)) return payload

	const { max_completion_tokens: _maxCompletionTokens, max_tokens: _maxTokens, ...rest } = payload
	return rest
}

export function omitKimchiMaxTokens(
	event: BeforeProviderRequestEvent,
	ctx: { model?: Pick<NonNullable<ExtensionContext["model"]>, "provider"> },
): unknown {
	if (!ctx.model) return
	const payload = omitKimchiMaxTokensFromPayload(event.payload, ctx.model.provider)
	return payload === event.payload ? undefined : payload
}

export default function omitKimchiMaxTokensExtension(pi: ExtensionAPI) {
	pi.on("before_provider_request", omitKimchiMaxTokens)
}
