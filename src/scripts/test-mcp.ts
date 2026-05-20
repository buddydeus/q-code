import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootstrapMcp, closeMcpSubsystem, reconnectMcpServer, summarizeMcpRegistry } from '../mcp/bootstrap'
import { buildMcpToolName } from '../mcp/names'
import { getMcpRegistryEntry } from '../mcp/registry'
import { ToolRegistry } from '../tools/registry'

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'q-code-mcp-'))
  const tmpHome = join(tmpRoot, 'home')
  const tmpProject = join(tmpRoot, 'project')
  const serverPath = join(tmpRoot, 'inline-mcp-server.mjs')

  try {
    await mkdir(join(tmpProject, '.q-code'), { recursive: true })
    await mkdir(tmpHome, { recursive: true })
    await writeFile(serverPath, buildInlineServerSource(), 'utf-8')
    await writeFile(
      join(tmpProject, '.q-code', 'settings.json'),
      JSON.stringify(
        {
          mcpServers: {
            'my.db': {
              command: process.execPath,
              args: [serverPath]
            }
          }
        },
        null,
        2
      ),
      'utf-8'
    )

    process.env.Q_CODE_HOME = tmpHome
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN

    const registry = new ToolRegistry()
    const result = await bootstrapMcp(tmpProject, registry)
    assert(result.config.errors.length === 0, `config errors: ${result.config.errors.join('; ')}`)
    assert(result.toolCount === 1, `expected 1 MCP tool, got ${result.toolCount}`)

    const toolName = buildMcpToolName('my.db', 'echo.tool')
    const tool = registry.get(toolName)
    assert(tool !== undefined, `missing tool ${toolName}`)
    assert(tool?.isReadOnly === true, 'readOnlyHint should map to isReadOnly')

    const discovered = registry.searchTools(toolName)
    assert(discovered.length === 1, 'tool_search path should discover the MCP tool')
    const output = await discovered[0].execute({ message: 'hello mcp' })
    assert(output === 'hello mcp', `unexpected tool output: ${String(output)}`)

    const entry = getMcpRegistryEntry('my.db')
    assert(entry?.connection.type === 'connected', 'registry should show connected server')
    assert(summarizeMcpRegistry().includes('my.db: connected'), 'summary should include connected server')

    const reconnected = await reconnectMcpServer('my.db', registry)
    assert(reconnected?.type === 'connected', 'reconnect should return connected state')

    console.log('MCP smoke test passed')
  } finally {
    await closeMcpSubsystem()
    delete process.env.Q_CODE_HOME
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

function buildInlineServerSource(): string {
  const serverModule = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js')
  const stdioModule = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js')
  const typesModule = import.meta.resolve('@modelcontextprotocol/sdk/types.js')

  return `
import { Server } from ${JSON.stringify(serverModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioModule)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesModule)};

const server = new Server(
  { name: "q-code-inline-test", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo.tool",
      description: "Echo a message for q-code MCP smoke tests.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"]
      },
      annotations: { readOnlyHint: true }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: String(request.params.arguments?.message ?? "")
    }
  ]
}));

await server.connect(new StdioServerTransport());
`
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
