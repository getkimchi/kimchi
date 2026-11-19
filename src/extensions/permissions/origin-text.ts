import type { PermissionOrigin } from "./prompter.js"

const MAX_IDENTITY_LENGTH = 120

/** Keep model-provided identity copy on one bounded, printable line. */
export function sanitizeIdentity(value: string | undefined): string | undefined {
	if (!value) return undefined
	const normalized = value
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
	if (!normalized) return undefined
	const characters = Array.from(normalized)
	if (characters.length <= MAX_IDENTITY_LENGTH) return normalized
	return `${characters
		.slice(0, MAX_IDENTITY_LENGTH - 1)
		.join("")
		.trimEnd()}…`
}

export function sanitizePermissionOrigin(origin: PermissionOrigin | undefined): PermissionOrigin | undefined {
	if (!origin) return undefined
	return {
		...origin,
		persona: sanitizeIdentity(origin.persona),
		description: sanitizeIdentity(origin.description),
	}
}
