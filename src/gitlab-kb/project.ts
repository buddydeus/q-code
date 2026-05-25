import { collectRepoInfo } from '../infra/git-info'
import type { InfraRepoInfo } from '../infra/types'
import { loadGitLabKbConfig, type GitLabKbConfig } from './config'

export interface GitLabKbTarget {
  config: GitLabKbConfig
  projectId: string
  projectPath?: string
  repo?: InfraRepoInfo
}

export async function resolveGitLabKbTarget(
  cwd: string,
  config: GitLabKbConfig = loadGitLabKbConfig()
): Promise<GitLabKbTarget> {
  if (!config.enabled) {
    throw new Error(config.disabledReason ?? 'GitLab KB 未启用')
  }
  if (!config.baseUrl || !config.token) {
    throw new Error('GitLab KB 需要配置 Q_CODE_GITLAB_URL 和 Q_CODE_GITLAB_TOKEN')
  }

  if (config.projectId) {
    return {
      config,
      projectId: encodeProjectId(config.projectId),
      projectPath: config.projectId
    }
  }

  if (config.projectPathFromUrl) {
    return {
      config,
      projectId: encodeProjectId(config.projectPathFromUrl),
      projectPath: config.projectPathFromUrl
    }
  }

  const repo = await collectRepoInfo(cwd)
  const projectPath = inferProjectPathFromRepo(config, repo)
  if (!projectPath) {
    throw new Error(
      '无法推断 GitLab project。请配置 Q_CODE_GITLAB_PROJECT_ID，或把 Q_CODE_GITLAB_URL 设为项目地址。'
    )
  }

  return {
    config,
    projectId: encodeProjectId(projectPath),
    projectPath,
    repo
  }
}

export function encodeProjectId(projectIdOrPath: string): string {
  return encodeURIComponent(projectIdOrPath.trim().replace(/\.git$/, '').replace(/^\/+|\/+$/g, ''))
}

export function inferProjectPathFromRepo(
  config: GitLabKbConfig,
  repo: Pick<InfraRepoInfo, 'remoteHost' | 'group' | 'name'>
): string | undefined {
  if (!repo.group || !repo.name) return undefined
  if (!config.baseUrl) return `${repo.group}/${repo.name}`

  try {
    const gitlabHost = new URL(config.baseUrl).hostname.toLowerCase()
    if (repo.remoteHost && repo.remoteHost.toLowerCase() !== gitlabHost) return undefined
  } catch {
    return undefined
  }

  return `${repo.group}/${repo.name}`
}
