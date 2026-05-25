import type { GitLabKbConfig } from './config'

export interface GitLabWikiPage {
  title: string
  slug: string
  content?: string
  format?: string
  encoding?: string
}

export interface GitLabWikiWriteInput {
  title: string
  content: string
  slug?: string
  format?: 'markdown' | 'rdoc' | 'asciidoc' | 'org'
}

export class GitLabKbHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string
  ) {
    super(message)
    this.name = 'GitLabKbHttpError'
  }
}

export class GitLabWikiClient {
  constructor(
    private readonly config: GitLabKbConfig,
    private readonly projectId: string
  ) {}

  async listPages(options: { withContent?: boolean; signal?: AbortSignal } = {}): Promise<GitLabWikiPage[]> {
    return this.request<GitLabWikiPage[]>('/wikis', {
      method: 'GET',
      query: options.withContent ? { with_content: '1' } : undefined,
      signal: options.signal
    })
  }

  async getPage(slug: string, options: { signal?: AbortSignal } = {}): Promise<GitLabWikiPage> {
    return this.request<GitLabWikiPage>(`/wikis/${encodeURIComponent(slug)}`, {
      method: 'GET',
      signal: options.signal
    })
  }

  async createPage(
    input: GitLabWikiWriteInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<GitLabWikiPage> {
    return this.request<GitLabWikiPage>('/wikis', {
      method: 'POST',
      form: {
        title: input.title,
        content: input.content,
        format: input.format ?? 'markdown'
      },
      signal: options.signal
    })
  }

  async updatePage(
    slug: string,
    input: GitLabWikiWriteInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<GitLabWikiPage> {
    return this.request<GitLabWikiPage>(`/wikis/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      form: {
        title: input.title,
        content: input.content,
        format: input.format ?? 'markdown'
      },
      signal: options.signal
    })
  }

  async upsertPage(
    input: GitLabWikiWriteInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ page: GitLabWikiPage; created: boolean }> {
    const slug = input.slug ?? slugFromTitle(input.title)
    try {
      await this.getPage(slug, options)
      return {
        page: await this.updatePage(slug, input, options),
        created: false
      }
    } catch (error) {
      if (!(error instanceof GitLabKbHttpError) || error.status !== 404) throw error
      return {
        page: await this.createPage(input, options),
        created: true
      }
    }
  }

  private async request<T>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE'
      query?: Record<string, string> | undefined
      form?: Record<string, string> | undefined
      signal?: AbortSignal
    }
  ): Promise<T> {
    if (!this.config.baseUrl || !this.config.token) {
      throw new Error('GitLab KB 未配置 baseUrl/token')
    }

    const url = new URL(
      `${this.config.baseUrl.replace(/\/+$/, '')}/api/v4/projects/${this.projectId}${path}`
    )
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) {
      abortFromCaller()
    } else {
      options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          Accept: 'application/json',
          'PRIVATE-TOKEN': this.config.token,
          ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        ...(options.form ? { body: new URLSearchParams(options.form) } : {}),
        signal: controller.signal
      })
      const text = await response.text()
      if (!response.ok) {
        throw new GitLabKbHttpError(formatGitLabError(response.status, text), response.status, text)
      }
      if (!text) return undefined as T
      return JSON.parse(text) as T
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

function formatGitLabError(status: number, text: string): string {
  const fallback = `GitLab Wiki API 请求失败: HTTP ${status}`
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown }
    const message = parsed.message ?? parsed.error
    if (typeof message === 'string') return `${fallback}: ${message}`
    if (message && typeof message === 'object') return `${fallback}: ${JSON.stringify(message)}`
  } catch {
    // keep fallback below
  }
  return `${fallback}: ${text.slice(0, 500)}`
}

export function slugFromTitle(title: string): string {
  return title
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
}
