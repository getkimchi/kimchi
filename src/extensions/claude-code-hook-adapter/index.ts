import { createCommandHookAdapter } from "../hook-adapters/adapter.js"
import { CLAUDE_CODE_HOOK_ADAPTER_DEFINITION } from "./definition.js"

export const claudeCodeHooksAdapter = createCommandHookAdapter(CLAUDE_CODE_HOOK_ADAPTER_DEFINITION)

export default claudeCodeHooksAdapter
