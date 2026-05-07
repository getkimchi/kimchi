import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AuditDigest, ConsolidationRecord, RollbackRecord, TransitionRecord } from "./types.js"

export function generateAuditDigest(
	skillCountBefore: number,
	consolidations: ConsolidationRecord[],
	autoTransitionsApplied: TransitionRecord[] = [],
	rollbacks: RollbackRecord[] = [],
): AuditDigest {
	const absorbedCount = consolidations.reduce((sum, c) => sum + c.members.length, 0)
	const umbrellaCount = consolidations.length
	const skillCountAfter = skillCountBefore - absorbedCount + umbrellaCount

	return {
		timestamp: new Date().toISOString(),
		skillCountBefore,
		skillCountAfter,
		consolidations,
		autoTransitionsApplied,
		rollbacks,
	}
}

export async function writeAuditReport(digest: AuditDigest, outputDir: string): Promise<void> {
	await mkdir(outputDir, { recursive: true })

	// Write JSON digest
	const jsonPath = join(outputDir, "audit.json")
	await writeFile(jsonPath, JSON.stringify(digest, null, 2))

	// Write markdown report
	const mdPath = join(outputDir, "REPORT.md")
	const md = formatMarkdownReport(digest)
	await writeFile(mdPath, md)
}

function formatMarkdownReport(digest: AuditDigest): string {
	const lines: string[] = [
		"# Curator Audit Report",
		"",
		`**Timestamp:** ${digest.timestamp}`,
		`**Skill Count:** ${digest.skillCountBefore} → ${digest.skillCountAfter}`,
		`**Delta:** ${digest.skillCountBefore - digest.skillCountAfter > 0 ? "-" : "+"}${Math.abs(digest.skillCountBefore - digest.skillCountAfter)}`,
		"",
	]

	if (digest.consolidations.length > 0) {
		lines.push("## Consolidations")
		for (const c of digest.consolidations) {
			lines.push(`### ${c.umbrella}`)
			lines.push(`- **Strategy:** ${c.strategy}`)
			lines.push(`- **Rationale:** ${c.rationale}`)
			lines.push(`- **Absorbed:** ${c.members.join(", ")}`)
			if (c.referencesCreated.length > 0) {
				lines.push(`- **References created:** ${c.referencesCreated.join(", ")}`)
			}
			lines.push("")
		}
	}

	if (digest.autoTransitionsApplied.length > 0) {
		lines.push("## Auto-Transitions")
		for (const t of digest.autoTransitionsApplied) {
			lines.push(`- ${t.name}: ${t.from} → ${t.to}`)
		}
		lines.push("")
	}

	if (digest.rollbacks.length > 0) {
		lines.push("## Rollbacks")
		for (const r of digest.rollbacks) {
			lines.push(`- ${r.timestamp}: ${r.reason} (${r.backupDir})`)
		}
		lines.push("")
	}

	return lines.join("\n")
}
