export type SuccessCriteria = string[]

function cleanItems(items: readonly string[]): SuccessCriteria {
	return items.map((item) => item.trim()).filter(Boolean)
}

export function normalizeSuccessCriteria(value: unknown): SuccessCriteria | undefined {
	if (value === undefined || value === null) return undefined
	if (Array.isArray(value)) {
		const items = cleanItems(value.filter((item): item is string => typeof item === "string"))
		return items.length > 0 ? items : undefined
	}
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	const items = cleanItems(trimmed.split(/\r?\n/).map((item) => item.replace(/^[-*]\s+/, "")))
	return items.length > 0 ? items : undefined
}

export function normalizeSuccessCriteriaInput(
	value: unknown,
	field = "success_criteria",
): { ok: true; value?: SuccessCriteria } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, value: undefined }
	if (Array.isArray(value)) {
		if (value.some((item) => typeof item !== "string")) {
			return { ok: false, error: `Field "${field}" must contain only strings.` }
		}
		return { ok: true, value: normalizeSuccessCriteria(value) }
	}
	if (typeof value === "string") return { ok: true, value: normalizeSuccessCriteria(value) }
	return { ok: false, error: `Field "${field}" must be a string or an array of strings.` }
}

export function successCriteriaToAnswer(criteria: unknown): string | undefined {
	const items = normalizeSuccessCriteria(criteria)
	if (!items || items.length === 0) return undefined
	return items.join("\n")
}

export function renderSuccessCriteria(criteria: unknown, empty = "(none specified)"): string {
	const items = normalizeSuccessCriteria(criteria)
	if (!items || items.length === 0) return empty
	if (items.length === 1) return items[0]
	return items.map((item) => `- ${item}`).join("\n")
}

export function renderLabeledSuccessCriteria(label: string, criteria: unknown, empty = "(none specified)"): string {
	const rendered = renderSuccessCriteria(criteria, empty)
	return rendered.includes("\n") ? `${label}:\n${rendered}` : `${label}: ${rendered}`
}
