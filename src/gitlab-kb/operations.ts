import { GitLabWikiClient, slugFromTitle, type GitLabWikiPage } from './client'
import { loadGitLabKbConfig, type GitLabKbConfig } from './config'
import { resolveGitLabKbTarget, type GitLabKbTarget } from './project'

export interface GitLabKbSearchOptions {
  cwd: string
  query?: string
  limit?: number
  signal?: AbortSignal
}

export interface GitLabKbReadOptions {
  cwd: string
  slug: string
  signal?: AbortSignal
}

export interface GitLabKbPublishOptions {
  cwd: string
  title: string
  content: string
  slug?: string
  signal?: AbortSignal
}

export interface ParsedGitLabKbPublishArgs {
  title: string
  content: string
  slug?: string
}

const DEFAULT_SEARCH_LIMIT = 10

export async function getGitLabKbStatus(cwd: string): Promise<string> {
  const config = loadGitLabKbConfig()
  const lines = ['GitLab Wiki KB', '']
  lines.push(`  enabled: ${config.enabled}`)
  lines.push(`  url: ${config.baseUrl ?? '(not configured)'}`)
  lines.push(`  token: ${config.token ? '(configured)' : '(missing)'}`)
  lines.push(`  project: ${config.projectId ?? config.projectPathFromUrl ?? '(infer from git origin)'}`)
  lines.push(`  prefix: ${config.pagePrefix || '(all wiki pages)'}`)
  lines.push(`  timeoutMs: ${config.timeoutMs}`)
  if (config.disabledReason) lines.push(`  hint: ${config.disabledReason}`)

  if (!config.enabled) {
    lines.push('', '  配置示例:')
    lines.push('    [gitlab_kb]')
    lines.push('    url = "https://gitlab.example.com/group/project"')
    lines.push('    token = "glpat-..."')
    return lines.join('\n')
  }

  try {
    const target = await resolveGitLabKbTarget(cwd, config)
    lines.push(`  resolvedProject: ${target.projectPath ?? decodeURIComponent(target.projectId)}`)
    const client = createClient(target)
    const pages = filterKnowledgePages(await client.listPages({ signal: undefined }), config)
    lines.push(`  wikiPages: ${pages.length}`)
  } catch (error) {
    lines.push(`  status: failed`)
    lines.push(`  error: ${formatError(error)}`)
  }

  return lines.join('\n')
}

export async function searchGitLabKb(options: GitLabKbSearchOptions): Promise<GitLabWikiPage[]> {
  const target = await resolveGitLabKbTarget(options.cwd)
  const client = createClient(target)
  const query = options.query?.trim().toLowerCase()
  const limit = clampLimit(options.limit)
  const pages = filterKnowledgePages(
    await client.listPages({ withContent: Boolean(query), signal: options.signal }),
    target.config
  )
  const matched = query
    ? pages.filter((page) =>
        [page.title, page.slug, page.content ?? ''].some((value) => value.toLowerCase().includes(query))
      )
    : pages
  return matched.slice(0, limit)
}

export async function readGitLabKbPage(options: GitLabKbReadOptions): Promise<GitLabWikiPage> {
  const target = await resolveGitLabKbTarget(options.cwd)
  const client = createClient(target)
  return client.getPage(normalizeKnowledgeSlug(options.slug, target.config), {
    signal: options.signal
  })
}

export async function publishGitLabKbPage(
  options: GitLabKbPublishOptions
): Promise<{ page: GitLabWikiPage; created: boolean }> {
  const target = await resolveGitLabKbTarget(options.cwd)
  const client = createClient(target)
  const title = normalizeKnowledgeTitle(options.title, target.config)
  const slug = normalizeKnowledgeSlug(options.slug ?? slugFromTitle(title), target.config)
  return client.upsertPage(
    {
      title,
      slug,
      content: withQCodeFooter(options.content)
    },
    { signal: options.signal }
  )
}

export function formatGitLabKbPages(pages: readonly GitLabWikiPage[], heading = 'GitLab Wiki KB'): string {
  const lines = [heading, '']
  if (pages.length === 0) {
    lines.push('  没有找到匹配的 Wiki 知识页。')
    return lines.join('\n')
  }

  for (const page of pages) {
    lines.push(`- ${page.title}`)
    lines.push(`  slug: ${page.slug}`)
    if (page.content) {
      const preview = page.content.replace(/\s+/g, ' ').trim()
      lines.push(`  preview: ${preview.length > 160 ? `${preview.slice(0, 157)}...` : preview}`)
    }
  }
  return lines.join('\n')
}

export function formatGitLabKbPage(page: GitLabWikiPage): string {
  return [
    `# ${page.title}`,
    '',
    `slug: ${page.slug}`,
    page.format ? `format: ${page.format}` : undefined,
    '',
    page.content ?? ''
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')
}

export function formatGitLabKbPublishResult(result: {
  page: GitLabWikiPage
  created: boolean
}): string {
  return [
    result.created ? '已发布 GitLab Wiki 知识页' : '已更新 GitLab Wiki 知识页',
    '',
    `  title: ${result.page.title}`,
    `  slug: ${result.page.slug}`
  ].join('\n')
}

export function parseGitLabKbPublishArgs(input: string): ParsedGitLabKbPublishArgs | null {
  const tokens = tokenizeArgs(input)
  if (tokens.length === 0) return null

  let title: string | undefined
  let slug: string | undefined
  const contentParts: string[] = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const next = tokens[index + 1]

    if (token === '--title') {
      if (!next) return null
      title = next
      index++
      continue
    }
    if (token.startsWith('--title=')) {
      title = token.slice('--title='.length).trim()
      if (!title) return null
      continue
    }
    if (token === '--slug') {
      if (!next) return null
      slug = next
      index++
      continue
    }
    if (token.startsWith('--slug=')) {
      slug = token.slice('--slug='.length).trim()
      if (!slug) return null
      continue
    }
    if (token.startsWith('-')) return null
    contentParts.push(token)
  }

  const content = contentParts.join(' ').trim()
  if (!title || !content) return null
  return {
    title,
    content,
    ...(slug ? { slug } : {})
  }
}

function createClient(target: GitLabKbTarget): GitLabWikiClient {
  return new GitLabWikiClient(target.config, target.projectId)
}

function filterKnowledgePages(pages: readonly GitLabWikiPage[], config: GitLabKbConfig): GitLabWikiPage[] {
  const prefix = config.pagePrefix
  if (!prefix) return [...pages]
  return pages.filter((page) => page.slug === prefix || page.slug.startsWith(`${prefix}/`))
}

function normalizeKnowledgeTitle(title: string, config: GitLabKbConfig): string {
  const normalized = title.trim().replace(/^\/+|\/+$/g, '')
  if (!config.pagePrefix || normalized === config.pagePrefix || normalized.startsWith(`${config.pagePrefix}/`)) {
    return normalized
  }
  return `${config.pagePrefix}/${normalized}`
}

function normalizeKnowledgeSlug(slug: string, config: GitLabKbConfig): string {
  const normalized = slug.trim().replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '')
  if (!config.pagePrefix || normalized === config.pagePrefix || normalized.startsWith(`${config.pagePrefix}/`)) {
    return normalized
  }
  return `${config.pagePrefix}/${normalized}`
}

function withQCodeFooter(content: string): string {
  const trimmed = content.trim()
  if (trimmed.includes('<!-- q-code-gitlab-kb -->')) return trimmed
  return `${trimmed}\n\n<!-- q-code-gitlab-kb -->`
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_SEARCH_LIMIT
  return Math.max(1, Math.min(30, Math.floor(limit)))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaping = false

  for (const char of input.trim()) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaping) current += '\\'
  if (quote) return []
  if (current) tokens.push(current)
  return tokens
}
