export interface InfraConfig {
  enabled: boolean
  baseUrl?: string
  token?: string
  clientId: string
  cacheDir: string
  syncOnStartup: boolean
  uploadSource: boolean
  timeoutMs: number
}

export interface InfraUserInfo {
  id?: string
  name?: string
  groups: string[]
}

export interface InfraRepoInfo {
  cwd: string
  remoteUrl?: string
  remoteHost?: string
  group?: string
  name?: string
  branch?: string
  commit?: string
  isDirty?: boolean
}

export interface InfraDomainInfo {
  id: string
  name: string
}

export interface InfraSkillRef {
  name: string
  version: string
  checksum?: string
  downloadUrl?: string
}

export interface InfraSkillPackage {
  name: string
  version: string
  checksum?: string
  files: Array<{
    path: string
    encoding?: string
    content: string
  }>
}

export interface InfraConfigPackage {
  packageId: string
  version: number
  checksum: string
  agentRules?: string
  domainRules?: Record<string, unknown>
  mcpServers?: Record<string, unknown>
  skills?: InfraSkillRef[]
  writePolicy?: {
    agentRules?: 'managed_block'
    mcpServers?: 'merge'
    skills?: 'replace_by_version'
  }
  expiresAt?: string
}

export interface InfraResolveConfigRequest {
  client: {
    id: string
    version: string
    platform: NodeJS.Platform
    shell?: string
  }
  user: InfraUserInfo
  repo: InfraRepoInfo
  currentState?: {
    packageId?: string
    version?: number
    checksum?: string
  }
}

export interface InfraResolveConfigResponse {
  matched: boolean
  matchReason?: string
  domain?: InfraDomainInfo
  configPackage?: InfraConfigPackage
}

export interface InfraState {
  clientId: string
  enabled: boolean
  status: 'never_synced' | 'applied' | 'stale' | 'disabled' | 'failed'
  lastSyncAt?: string
  lastSuccessAt?: string
  lastError?: string
  matchReason?: string
  domain?: InfraDomainInfo
  packageId?: string
  version?: number
  checksum?: string
  written?: InfraWriteSummary
  repo?: InfraRepoInfo
}

export interface InfraWriteSummary {
  settingsPath?: string
  agentRulesPath?: string
  statePath: string
  mcpServersWritten: string[]
  skillsWritten: string[]
  agentRulesUpdated: boolean
}

export interface InfraSyncResult {
  status: InfraState['status']
  state: InfraState
  message: string
  usedCache: boolean
  wroteConfig: boolean
}
