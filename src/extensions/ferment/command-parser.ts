import { stripOuterQuotes } from "../../ferment/text.js"

export type FermentCommand =
	| { type: "interactive" }
	| { type: "list" }
	| { type: "manual-policy" }
	| { type: "auto-policy" }
	| { type: "progress" }
	| { type: "pause-lifecycle" }
	| { type: "resume-lifecycle" }
	| { type: "exit" }
	| { type: "delete"; target: string }
	| { type: "switch"; verb: "switch"; target: string; force: boolean }
	| { type: "abandon"; reason?: string }
	| { type: "revise"; field: string }
	| { type: "export" }
	| { type: "one-shot"; intent: string }
	| { type: "new"; title: string }
	| { type: "unknown"; input: string }

function parseSwitch(raw: string): FermentCommand {
	const verb = "switch"
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
	if (lo === "manual") return { type: "manual-policy" }
	if (lo === "auto") return { type: "auto-policy" }
	if (lo === "progress") return { type: "progress" }
	if (lo === "pause") return { type: "pause-lifecycle" }
	if (lo === "resume") return { type: "resume-lifecycle" }
	if (lo === "exit") return { type: "exit" }
	if (lo.startsWith("delete ")) return { type: "delete", target: stripOuterQuotes(raw.slice("delete ".length)) }
	if (lo.startsWith("switch ")) return parseSwitch(raw)
	if (lo === "abandon") return { type: "abandon" }
	if (lo.startsWith("abandon ")) return { type: "abandon", reason: stripOuterQuotes(raw.slice("abandon".length)) }
	if (lo.startsWith("revise ")) return { type: "revise", field: lo.slice("revise ".length).trim() }
	if (lo === "export" || lo.startsWith("export ")) return { type: "export" }
	if (lo === "one-shot" || lo.startsWith("one-shot "))
		return { type: "one-shot", intent: stripOuterQuotes(raw.slice("one-shot".length)) }
	if (lo === "new") return { type: "new", title: "" }
	if (lo.startsWith("new ")) return { type: "new", title: stripOuterQuotes(raw.slice("new ".length)) }
	return { type: "unknown", input: raw }
}
