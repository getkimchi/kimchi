import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export function saveApprovedPlan(cwd: string, planText: string): string {
	const plansDir = resolve(cwd, ".kimchi", "plans")
	if (!existsSync(plansDir)) mkdirSync(plansDir, { recursive: true })
	const fileName = `plan-${Date.now()}.md`
	const filePath = resolve(plansDir, fileName)
	writeFileSync(filePath, planText, "utf-8")
	return filePath
}
