export interface GitLabKbConfig {
  enabled: boolean
  baseUrl?: string
  token?: string
  projectId?: string
  projectPathFromUrl?: string
  pagePrefix: string
  timeoutMs: number
  disabledReason?: string
}

export interface ParsedGitLabUrl {
  baseUrl: string
  projectPath?: string
}

const DEFAULT_PAGE_PREFIX = 'q-code-kb'
const DEFAULT_TIMEOUT_MS = 10000

export function loadGitLabKbConfig(
  env: Pick<NodeJS.ProcessEnv, string> = process.env
): GitLabKbConfig {
  const enabledRaw = clean(env.Q_CODE_GITLAB_KB_ENABLED)
  const urlRaw = clean(env.Q_CODE_GITLAB_URL)
  const token = clean(env.Q_CODE_GITLAB_TOKEN)
  const projectId = clean(env.Q_CODE_GITLAB_PROJECT_ID)
  const pagePrefix = normalizePrefix(clean(env.Q_CODE_GITLAB_KB_PREFIX) ?? DEFAULT_PAGE_PREFIX)
  const timeoutMs = getPositiveNumber(env.Q_CODE_GITLAB_KB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const parsedUrl = urlRaw ? parseGitLabUrl(urlRaw) : undefined

  if (isFalse(enabledRaw)) {
    return {
      enabled: false,
      ...(parsedUrl?.baseUrl ? { baseUrl: parsedUrl.baseUrl } : {}),
      ...(token ? { token } : {}),
      ...(projectId ? { projectId } : {}),
      ...(parsedUrl?.projectPath ? { projectPathFromUrl: parsedUrl.projectPath } : {}),
      pagePrefix,
      timeoutMs,
      disabledReason: 'Q_CODE_GITLAB_KB_ENABLED=false'
    }
  }

  const missing: string[] = []
  if (!parsedUrl?.baseUrl) missing.push('Q_CODE_GITLAB_URL')
  if (!token) missing.push('Q_CODE_GITLAB_TOKEN')
  const enabled = missing.length === 0 && (enabledRaw ? isTrue(enabledRaw) : true)

  return {
    enabled,
    ...(parsedUrl?.baseUrl ? { baseUrl: parsedUrl.baseUrl } : {}),
    ...(token ? { token } : {}),
    ...(projectId ? { projectId } : {}),
    ...(parsedUrl?.projectPath ? { projectPathFromUrl: parsedUrl.projectPath } : {}),
    pagePrefix,
    timeoutMs,
    ...(enabled
      ? {}
      : { disabledReason: missing.length > 0 ? `缺少 ${missing.join(', ')}` : '未启用' })
  }
}

export function parseGitLabUrl(raw: string): ParsedGitLabUrl | undefined {
  const trimmed = raw.trim().replace(/\.git$/, '')
  if (!trimmed) return undefined

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  const path = url.pathname.replace(/\/+$/, '')
  const apiIndex = path.indexOf('/api/v4')
  if (apiIndex >= 0) {
    return {
      baseUrl: `${url.origin}${path.slice(0, apiIndex)}` || url.origin
    }
  }

  const projectPath = path.replace(/^\/+/, '')
  return {
    baseUrl: url.origin,
    ...(projectPath ? { projectPath } : {})
  }
}

function normalizePrefix(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '-')
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function isFalse(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes((value ?? '').toLowerCase())
}

function isTrue(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase())
}

function getPositiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
