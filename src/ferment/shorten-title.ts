import { loadConfig } from "../config.js"

const SYSTEM_PROMPT =
	"You are a title generator. Respond with ONLY a short title. 1-5 words, no quotes, no explanation, no markdown."

/** Deterministic fallback when LLM is unavailable. */
function autoShortTitle(name: string): string {
	const max = 35
	if (name.length <= max) return name.trim()
	const truncated = name.slice(0, max)
	const lastSpace = truncated.lastIndexOf(" ")
	return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim()
}

/**
 * Ask a cheap LLM to generate a short title for the raw user intent.
 * Falls back to deterministic truncation on any error.
 */
export async function shortenTitle(rawIntent: string): Promise<string> {
	const config = loadConfig()
	const apiKey = config.apiKey || process.env.KIMCHI_API_KEY || ""

	if (!apiKey) {
		return autoShortTitle(rawIntent)
	}

	try {
		const response = await fetch(`${config.llmEndpoint}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: "nemotron-3-super-fp4",
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: `Short title for: "${rawIntent}"` },
				],
				max_tokens: 20,
				temperature: 0,
			}),
		})

		if (!response.ok) {
			return autoShortTitle(rawIntent)
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>
		}
		const title = data.choices?.[0]?.message?.content?.trim() ?? ""
		if (title.length > 0) return title
		return autoShortTitle(rawIntent)
	} catch {
		return autoShortTitle(rawIntent)
	}
}
