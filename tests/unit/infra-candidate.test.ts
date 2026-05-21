import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseKnowledgeCandidateArgs, submitInfraKnowledgeCandidate } from '../../src/infra'
import { ToolRegistry } from '../../src/tools/registry'
import { makeRecordingTool } from '../_helpers/mock-tool'

describe('infra knowledge candidate', () => {
  it('解析最小候选知识参数', () => {
    expect(parseKnowledgeCandidateArgs('接口路径必须以 / 开头')).toEqual({
      type: 'faq',
      title: '接口路径必须以 / 开头',
      content: '接口路径必须以 / 开头'
    })
  })

  it('解析带类型、标题、业务域和仓库的候选知识参数', () => {
    expect(
      parseKnowledgeCandidateArgs(
        '--type pitfall --title "tsconfig 类型报错" --domain domain_demo --repo git.example.com/a/b tsconfig 只配置 react 会触发类型解析问题'
      )
    ).toEqual({
      type: 'pitfall',
      title: 'tsconfig 类型报错',
      domainId: 'domain_demo',
      repo: 'git.example.com/a/b',
      content: 'tsconfig 只配置 react 会触发类型解析问题'
    })
  })

  it('通过 enterprise_kb MCP 工具提交候选知识', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'q-code-infra-candidate-'))
    const registry = new ToolRegistry({ cwd, quiet: true })
    const { tool, calls } = makeRecordingTool(
      'mcp__enterprise_kb__submit_knowledge_candidate',
      JSON.stringify({
        candidateId: 'cand_unit',
        status: 'pending_review',
        reviewPriority: 'high'
      }),
      {
        isReadOnly: false,
        shouldDefer: true
      }
    )
    registry.register(tool)

    const result = await submitInfraKnowledgeCandidate({
      cwd,
      registry,
      args: '--type decision --title "统一走平台请求封装" 所有接口请求必须复用平台 request 封装。'
    })

    expect(result.ok).toBe(true)
    expect(result.candidateId).toBe('cand_unit')
    expect(result.toolName).toBe('mcp__enterprise_kb__submit_knowledge_candidate')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toMatchObject({
      type: 'decision',
      title: '统一走平台请求封装',
      content: '所有接口请求必须复用平台 request 封装。'
    })
    expect(calls[0]?.input).toHaveProperty('source')
  })

  it('兼容 MCP 适配器返回 text content 与 structuredContent 拼接的输出', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'q-code-infra-candidate-'))
    const registry = new ToolRegistry({ cwd, quiet: true })
    registry.register(
      makeRecordingTool(
        'mcp__enterprise_kb__submit_knowledge_candidate',
        [
          JSON.stringify({
            candidateId: 'cand_text',
            status: 'pending_review',
            reviewPriority: 'medium'
          }),
          JSON.stringify({
            candidateId: 'cand_structured',
            status: 'pending_review',
            reviewPriority: 'medium'
          })
        ].join('\n'),
        {
          isReadOnly: false,
          shouldDefer: true
        }
      ).tool
    )

    const result = await submitInfraKnowledgeCandidate({
      cwd,
      registry,
      args: 'MCP 适配器可能返回多段 JSON，提交结果要能读取第一段。'
    })

    expect(result.ok).toBe(true)
    expect(result.candidateId).toBe('cand_text')
  })
})
