import { describe, expect, it, vi } from 'vitest'
import { CWD_REGEX, fillMissingRequired, PROJECT_PATH_REGEX } from './context-providers.js'
import type { ToolMetadata } from './types.js'

function makeMeta(required: string[], additionalProperties = {}): ToolMetadata {
  return {
    name: 'test_tool',
    originalName: 'test_tool',
    description: '',
    prefix: '',
    serverName: 'test',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        cwd: { type: 'string' },
        optionalParam: { type: 'string' },
        ...additionalProperties,
      },
      required,
    },
  } as ToolMetadata
}

describe('fillMissingRequired', () => {
  it('fills missing required projectPath from cwd', () => {
    const meta = makeMeta(['projectPath'])
    const result = fillMissingRequired(meta, {}, { cwd: '/kimchi' })
    expect(result.projectPath).toBe('/kimchi')
  })

  it('does NOT overwrite a caller-supplied value', () => {
    const meta = makeMeta(['projectPath'])
    const result = fillMissingRequired(meta, { projectPath: '/other' }, { cwd: '/kimchi' })
    expect(result.projectPath).toBe('/other')
  })

  it('does NOT fill optional params even if empty', () => {
    const meta = makeMeta(['projectPath'])
    const result = fillMissingRequired(meta, {}, { cwd: '/kimchi' })
    expect('optionalParam' in result).toBe(false)
  })

  it('does NOT fill when inputSchema is missing', () => {
    const result = fillMissingRequired(undefined, { a: 1 }, { cwd: '/' })
    expect(result).toEqual({ a: 1 })
  })

  it('fills cwd param from cwd context', () => {
    const meta = makeMeta(['cwd'])
    const result = fillMissingRequired(meta, {}, { cwd: '/work' })
    expect(result.cwd).toBe('/work')
  })

  it('logs each fill when logger provided', () => {
    const log = vi.fn()
    const meta = makeMeta(['projectPath'])
    fillMissingRequired(meta, {}, { cwd: '/kimchi' }, log)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toMatch(/auto-fill: projectPath.*provider:/)
  })

  it('does not fill empty string — preserves caller value', () => {
    const meta = makeMeta(['projectPath'])
    const result = fillMissingRequired(meta, { projectPath: '' }, { cwd: '/kimchi' })
    expect(result.projectPath).toBe('')
  })

  it('does NOT fill when inputSchema has no required array', () => {
    const meta = {
      name: 'test_tool',
      originalName: 'test_tool',
      description: '',
      prefix: '',
      serverName: 'test',
      inputSchema: { type: 'object', properties: { projectPath: { type: 'string' } } },
    } as ToolMetadata
    const result = fillMissingRequired(meta, {}, { cwd: '/kimchi' })
    expect('projectPath' in result).toBe(false)
  })

  it('fills missing required param with empty string when cwd is empty string', () => {
    const meta = makeMeta(['projectPath'])
    const result = fillMissingRequired(meta, {}, { cwd: '' })
    expect(result.projectPath).toBe('')
  })

  it('does NOT overwrite a caller-supplied null value', () => {
    const meta = makeMeta(['projectPath'])
    const result = fillMissingRequired(meta, { projectPath: null }, { cwd: '/kimchi' })
    expect(result.projectPath).toBeNull()
  })
})

describe('PROJECT_PATH_REGEX — matches project-path-like property names', () => {
  it.each([
    'projectPath',
    'project_path',
    'project-path',
    'projectRoot',
    'project_root',
    'project-root',
    'repoRoot',
    'repo_root',
    'repo-root',
  ])('matches "%s"', (name) => {
    expect(PROJECT_PATH_REGEX.test(name)).toBe(true)
  })

  it.each(['path', 'projectDir', 'root', 'repo', 'project_path_extra', 'cwd', 'workingDirectory'])('does NOT match "%s"', (name) => {
    expect(PROJECT_PATH_REGEX.test(name)).toBe(false)
  })
})

describe('CWD_REGEX — matches working-directory-like property names', () => {
  it.each(['cwd', 'workingDirectory', 'working_directory'])('matches "%s"', (name) => {
    expect(CWD_REGEX.test(name)).toBe(true)
  })

  it.each(['wd', 'directory', 'workDir', 'workingDir', 'projectPath'])('does NOT match "%s"', (name) => {
    expect(CWD_REGEX.test(name)).toBe(false)
  })
})
