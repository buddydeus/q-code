import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitLabWikiClient,
  encodeProjectId,
  getGitLabKbStatus,
  inferProjectPathFromRepo,
  loadGitLabKbConfig,
  parseGitLabKbPublishArgs,
  parseGitLabUrl
} from '../../src/gitlab-kb'

const ENV_KEYS = [
  'Q_CODE_GITLAB_KB_ENABLED',
  'Q_CODE_GITLAB_URL',
  'Q_CODE_GITLAB_TOKEN',
  'Q_CODE_GITLAB_PROJECT_ID',
  'Q_CODE_GITLAB_KB_PREFIX',
  'Q_CODE_GITLAB_KB_TIMEOUT_MS'
]

const previousEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) previousEnv[key] = process.env[key]

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) restoreEnv(key, previousEnv[key])
})

describe('gitlab wiki kb', () => {
  it('parses GitLab instance and project URLs', () => {
    expect(parseGitLabUrl('https://gitlab.example.com')).toEqual({
      baseUrl: 'https://gitlab.example.com'
    })
    expect(parseGitLabUrl('https://gitlab.example.com/group/sub/project.git')).toEqual({
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'group/sub/project'
    })
    expect(parseGitLabUrl('https://gitlab.example.com/api/v4')).toEqual({
      baseUrl: 'https://gitlab.example.com'
    })
    expect(parseGitLabUrl('not a url')).toBeUndefined()
  })

  it('loads config only when url and token are present', () => {
    process.env.Q_CODE_GITLAB_URL = 'https://gitlab.example.com/group/project'
    process.env.Q_CODE_GITLAB_TOKEN = 'glpat-test'
    process.env.Q_CODE_GITLAB_KB_PREFIX = ' team docs '

    expect(loadGitLabKbConfig()).toMatchObject({
      enabled: true,
      baseUrl: 'https://gitlab.example.com',
      token: 'glpat-test',
      projectPathFromUrl: 'group/project',
      pagePrefix: 'team-docs'
    })

    delete process.env.Q_CODE_GITLAB_TOKEN
    expect(loadGitLabKbConfig()).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Q_CODE_GITLAB_TOKEN')
    })
  })

  it('infers and encodes project paths', () => {
    expect(
      inferProjectPathFromRepo(
        { enabled: true, baseUrl: 'https://gitlab.example.com', token: 'x', pagePrefix: 'kb', timeoutMs: 1 },
        { remoteHost: 'gitlab.example.com', group: 'frontend/platform', name: 'app' }
      )
    ).toBe('frontend/platform/app')
    expect(encodeProjectId('frontend/platform/app')).toBe('frontend%2Fplatform%2Fapp')
  })

  it('upserts an existing wiki page with encoded project id and private token', async () => {
    process.env.Q_CODE_GITLAB_URL = 'https://gitlab.example.com/group/project'
    process.env.Q_CODE_GITLAB_TOKEN = 'glpat-test'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ title: 'q-code-kb/Deploy', slug: 'q-code-kb/deploy' })
    ).mockResolvedValueOnce(
      jsonResponse({ title: 'q-code-kb/Deploy', slug: 'q-code-kb/deploy', content: 'updated' })
    )
    const config = loadGitLabKbConfig()
    const client = new GitLabWikiClient(config, encodeProjectId('group/project'))

    const result = await client.upsertPage({
      title: 'q-code-kb/Deploy',
      slug: 'q-code-kb/deploy',
      content: 'updated'
    })

    expect(result.created).toBe(false)
    expect(result.page.content).toBe('updated')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toContain('/api/v4/projects/group%2Fproject/wikis/q-code-kb%2Fdeploy')
    expect(init?.method).toBe('PUT')
    expect(init?.headers).toMatchObject({ 'PRIVATE-TOKEN': 'glpat-test' })
    expect(String(init?.body)).toContain('content=updated')
  })

  it('creates a wiki page when the slug does not exist', async () => {
    process.env.Q_CODE_GITLAB_URL = 'https://gitlab.example.com/group/project'
    process.env.Q_CODE_GITLAB_TOKEN = 'glpat-test'
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ message: '404 Not found' }, { status: 404 })
    ).mockResolvedValueOnce(
      jsonResponse({ title: 'q-code-kb/API FAQ', slug: 'q-code-kb/api-faq' }, { status: 201 })
    )
    const client = new GitLabWikiClient(loadGitLabKbConfig(), encodeProjectId('group/project'))

    await expect(
      client.upsertPage({
        title: 'q-code-kb/API FAQ',
        slug: 'q-code-kb/api-faq',
        content: 'content'
      })
    ).resolves.toMatchObject({ created: true })
  })

  it('formats status without leaking token', async () => {
    process.env.Q_CODE_GITLAB_URL = 'https://gitlab.example.com/group/project'
    process.env.Q_CODE_GITLAB_TOKEN = 'secret-token'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([{ title: 'q-code-kb/API', slug: 'q-code-kb/api' }])
    )

    const status = await getGitLabKbStatus(process.cwd())

    expect(status).toContain('token: (configured)')
    expect(status).toContain('wikiPages: 1')
    expect(status).not.toContain('secret-token')
  })

  it('parses publish command args', () => {
    expect(
      parseGitLabKbPublishArgs('--title "部署流程" --slug deploy/runbook 发布前先跑测试')
    ).toEqual({
      title: '部署流程',
      slug: 'deploy/runbook',
      content: '发布前先跑测试'
    })
  })
})

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' }
  })
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
