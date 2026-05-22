import { mkdirSync, writeFileSync } from "node:fs"

mkdirSync("src/generated", { recursive: true })
writeFileSync(
	"src/generated/posthog-key.generated.ts",
	`// Auto-generated stub — overwritten during release builds.
export const KIMCHI_POSTHOG_API_KEY = ""
`,
)
