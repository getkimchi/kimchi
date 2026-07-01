/**
 * Redaction engine for tool-result text content.
 *
 * Two-stage pipeline:
 * 1. Exact-match: replace each known secret value with [REDACTED].
 *    Zero false positives.
 * 2. Pattern catalog: replace matches from PATTERN_CATALOG with [REDACTED].
 *    Catches unknown secrets in common formats.
 *
 * Stateless. No I/O. Deterministic.
 */

const REDACTED = "[REDACTED]"

const MIN_SECRET_LENGTH = 8

export interface SecretPattern {
	name: string
	regex: RegExp
}

export const PATTERN_CATALOG: SecretPattern[] = [
	{ name: "AWS access key ID", regex: /AKIA[0-9A-Z]{16}/g },
	{ name: "AWS secret in config", regex: /(?<=aws_secret_access_key\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/g },
	{ name: "GitHub classic token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
	{ name: "GitHub fine-grained PAT", regex: /github_pat_[A-Za-z0-9_]{22,}/g },
	{ name: "GitLab token", regex: /glpat-[A-Za-z0-9_-]{20,}/g },
	// JWT: header starts with eyJ (base64 of `{"`); payload and signature are
	// base64url segments that rarely start with eyJ, so only require minimum length.
	{ name: "JWT", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
	{
		name: "PEM private key",
		regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	{ name: "Slack token", regex: /xox[baprs]-[A-Za-z0-9-]+/g },
	{ name: "Generic Bearer", regex: /[Bb]earer [A-Za-z0-9._+/=-]{8,}/g },
	{
		name: "Env/config secret assignment",
		regex:
			/(?<=\w*(?:API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*\s*[=:]\s*["']?)[A-Za-z0-9_+/=-]{8,}/gi,
	},
]

/**
 * Redact known secrets and common credential patterns from text.
 *
 * @param text - The text to scrub.
 * @param knownSecrets - A set of exact secret values to redact.
 * @returns The scrubbed text with secrets replaced by [REDACTED].
 */
export function redact(text: string, knownSecrets: Set<string>): string {
	if (!text) return text

	let result = text

	// Stage 1: Exact-match known secrets.
	// Use split().join() instead of replaceAll to avoid regex special-character
	// issues in secret values.
	for (const secret of knownSecrets) {
		if (secret.length < MIN_SECRET_LENGTH) continue
		if (!result.includes(secret)) continue
		result = result.split(secret).join(REDACTED)
	}

	// Stage 2: Pattern catalog.
	for (const pattern of PATTERN_CATALOG) {
		// Reset lastIndex in case the regex was used before (global flag).
		pattern.regex.lastIndex = 0
		result = result.replace(pattern.regex, REDACTED)
	}

	return result
}
