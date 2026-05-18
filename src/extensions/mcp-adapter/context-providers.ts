import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ToolMetadata } from './types.js'

type ContextProvider = {
  matchName: RegExp
  resolve: (ctx: Pick<ExtensionContext, 'cwd'>) => string | undefined
}

export const PROJECT_PATH_REGEX = /^(project[_-]?path|project[_-]?root|repo[_-]?root)$/i
export const CWD_REGEX = /^(cwd|working[_-]?directory)$/i

const DEFAULT_PROVIDERS: ContextProvider[] = [
  {
    matchName: PROJECT_PATH_REGEX,
    resolve: (c) => c.cwd,
  },
  {
    matchName: CWD_REGEX,
    resolve: (c) => c.cwd,
  },
]

/**
 * Merge caller-supplied args with auto-filled required params.
 * Only fills required params that are missing or null.
 * Never overwrites a caller-supplied value.
 */
export function fillMissingRequired(
  metadata: ToolMetadata | undefined,
  callerArgs: Record<string, unknown>,
  ctx: Pick<ExtensionContext, 'cwd'>,
  log?: (msg: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...callerArgs }
  if (!metadata?.inputSchema) return out

  // ToolMetadata.inputSchema is typed 'unknown' because JSON Schema shapes vary by MCP server.
  const schema = metadata.inputSchema as { required?: string[] } | undefined
  const required = schema?.required ?? []
  for (const key of required) {
    // Skip if caller provided a value (even empty string — preserve explicit caller intent)
    if (key in out) continue

    for (const p of DEFAULT_PROVIDERS) {
      if (!p.matchName.test(key)) continue
      const value = p.resolve(ctx)
      if (value != null) {
        out[key] = value
        log?.(`[mcp-adapter] auto-fill: ${key} = "${value}" (provider: ${p.matchName.source})`)
        break
      }
    }
  }
  return out
}
