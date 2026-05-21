import { describe, expect, it } from 'vitest'
import { loadInfraConfig } from '../../src/infra/config'
import { parseGitRemote } from '../../src/infra/git-info'
import { replaceManagedBlock } from '../../src/infra/writers'

describe('infra config', () => {
  it('默认关闭，即使配置了地址也不自动启用', () => {
    const previous = {
      enabled: process.env.Q_CODE_INFRA_ENABLED,
      baseUrl: process.env.Q_CODE_INFRA_BASE_URL,
      token: process.env.Q_CODE_INFRA_TOKEN
    }
    try {
      delete process.env.Q_CODE_INFRA_ENABLED
      process.env.Q_CODE_INFRA_BASE_URL = 'https://ai-infra.example.com'
      process.env.Q_CODE_INFRA_TOKEN = 'token'
      expect(loadInfraConfig().enabled).toBe(false)
    } finally {
      restoreEnv('Q_CODE_INFRA_ENABLED', previous.enabled)
      restoreEnv('Q_CODE_INFRA_BASE_URL', previous.baseUrl)
      restoreEnv('Q_CODE_INFRA_TOKEN', previous.token)
    }
  })

  it('显式设置 Q_CODE_INFRA_ENABLED=true 才启用', () => {
    const previous = process.env.Q_CODE_INFRA_ENABLED
    try {
      process.env.Q_CODE_INFRA_ENABLED = 'true'
      expect(loadInfraConfig().enabled).toBe(true)
    } finally {
      restoreEnv('Q_CODE_INFRA_ENABLED', previous)
    }
  })
})

describe('infra git remote parsing', () => {
  it('解析 HTTPS remote', () => {
    expect(parseGitRemote('https://git.example.com/group/sub/repo.git')).toEqual({
      remoteHost: 'git.example.com',
      group: 'group/sub',
      name: 'repo'
    })
  })

  it('解析 SSH remote', () => {
    expect(parseGitRemote('git@git.example.com:supply-chain/demo.git')).toEqual({
      remoteHost: 'git.example.com',
      group: 'supply-chain',
      name: 'demo'
    })
  })
})

describe('infra managed block', () => {
  const block = [
    '<!-- q-code-infra:start package=cfg version=1 checksum=sha256:abc -->',
    '企业规则',
    '<!-- q-code-infra:end -->'
  ].join('\n')

  it('追加受管区块并保留用户内容', () => {
    expect(replaceManagedBlock('# 用户规则\n', block)).toBe(`# 用户规则\n\n${block}\n`)
  })

  it('替换已有受管区块并保留后续内容', () => {
    const existing = [
      '# 用户规则',
      '',
      '<!-- q-code-infra:start package=old version=1 checksum=sha256:old -->',
      '旧规则',
      '<!-- q-code-infra:end -->',
      '',
      '## 本地补充'
    ].join('\n')

    expect(replaceManagedBlock(existing, block)).toBe(
      ['# 用户规则', '', block, '', '## 本地补充', ''].join('\n')
    )
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
