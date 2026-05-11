export type FermentCommand =
	| { type: "interactive" }
	| { type: "list" }
	| { type: "mode"; mode?: string }
	| { type: "delete"; target: string }
	| { type: "switch"; verb: "switch" | "use" | "resume"; target: string; force: boolean }
	| { type: "abandon"; reason?: string }
	| { type: "revise"; field: string }
	| { type: "export" }
	| { type: "one-shot"; intent: string }
	| { type: "add"; title: string }

export function stripOuterQuotes(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length >= 2) {
		const first = trimmed[0]
		const last = trimmed[trimmed.length - 1]
		if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
			return trimmed.slice(1, -1).trim()
		}
	}
	return trimmed
}

function parseSwitch(raw: string, verb: "switch" | "use" | "resume"): FermentCommand {
	const rest = raw.slice(verb.length).trim()
	const force = /(?:^|\s)--force(?:\s|$)/.test(rest)
	const target = stripOuterQuotes(rest.replace(/(?:^|\s)--force(?:\s|$)/g, " ").trim())
	return { type: "switch", verb, target, force }
}

export function parseFermentCommand(args: string): FermentCommand {
	const raw = args.trim()
	const lo = raw.toLowerCase()

	if (raw === "") return { type: "interactive" }
	if (lo === "list") return { type: "list" }
	if (lo === "mode") return { type: "mode" }
	if (lo.startsWith("mode ")) return { type: "mode", mode: lo.slice("mode ".length).trim() }
	if (lo.startsWith("delete ")) return { type: "delete", target: stripOuterQuotes(raw.slice("delete ".length)) }
	if (lo.startsWith("switch ")) return parseSwitch(raw, "switch")
	if (lo.startsWith("use ")) return parseSwitch(raw, "use")
	if (lo.startsWith("resume ")) return parseSwitch(raw, "resume")
	if (lo === "abandon") return { type: "abandon" }
	if (lo.startsWith("abandon ")) return { type: "abandon", reason: stripOuterQuotes(raw.slice("abandon".length)) }
	if (lo.startsWith("revise ")) return { type: "revise", field: lo.slice("revise ".length).trim() }
	if (lo === "export" || lo.startsWith("export ")) return { type: "export" }
	if (lo.startsWith("one-shot")) return { type: "one-shot", intent: stripOuterQuotes(raw.slice("one-shot".length)) }
	if (lo === "add") return { type: "add", title: "" }
	if (lo.startsWith("add ")) return { type: "add", title: stripOuterQuotes(raw.slice("add ".length)) }
	return { type: "add", title: stripOuterQuotes(raw) }
}
