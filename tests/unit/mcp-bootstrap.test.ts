import { describe, expect, it } from 'vitest'
import { describeTransportForCrashReport } from '../../src/mcp/bootstrap'

describe('MCP bootstrap crash snapshots', () => {
  it('HTTP/SSE transport 快照只保留 origin，不泄露 query token', () => {
    expect(
      describeTransportForCrashReport({
        type: 'http',
        url: 'https://token@example.com/mcp/project?access_token=secret#frag',
        scope: 'project'
      })
    ).toEqual({
      transportType: 'http',
      scope: 'project',
      urlOrigin: 'https://example.com'
    })
  })

  it('stdio transport 快照不记录原始 args', () => {
    expect(
      describeTransportForCrashReport({
        type: 'stdio',
        command: 'C:\\tools\\mcp-server.exe',
        args: ['--token', 'secret'],
        scope: 'user'
      })
    ).toEqual({
      transportType: 'stdio',
      scope: 'user',
      command: 'mcp-server.exe',
      argCount: 2
    })
  })
})
