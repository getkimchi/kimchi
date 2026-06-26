import { homedir } from "node:os"
import { join } from "node:path"
import { resolveAuxiliaryFilesDir } from "../../auxiliary-files/resolver.js"

export const SUPERPOWERS_SKILL_PATH = join(
	resolveAuxiliaryFilesDir(process.env, homedir(), process.execPath),
	"vendor",
	"superpowers",
	"skills",
)
