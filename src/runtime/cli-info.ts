import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type EarlyCliCommand = 'help' | 'version'

let cachedPackageVersion: string | undefined

export function getPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion

  const startDir = dirname(fileURLToPath(import.meta.url))
  for (const filePath of getPackageJsonCandidates(startDir)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        name?: unknown
        version?: unknown
      }
      if (parsed.name === '@q-code-cli/q-code' && typeof parsed.version === 'string') {
        cachedPackageVersion = parsed.version
        return cachedPackageVersion
      }
    } catch {
      // Keep walking; --version should never fail because package metadata is unavailable.
    }
  }

  cachedPackageVersion = process.env.npm_package_version?.trim() || '0.0.0'
  return cachedPackageVersion
}

export function getEarlyCliCommand(argv: string[]): EarlyCliCommand | undefined {
  const first = argv[0]
  if (first === 'help' || argv.includes('--help') || argv.includes('-h')) return 'help'
  if (first === 'version' || argv.includes('--version') || argv.includes('-v')) return 'version'
  return undefined
}

export function formatCliVersion(version: string): string {
  return `q-code ${version}`
}

export function formatCliHelp(version: string): string {
  return [
    formatCliVersion(version),
    '',
    'Usage:',
    '  q-code [options]',
    '  q-code help',
    '  q-code version',
    '',
    'Options:',
    '  -h, --help                Show help and exit',
    '  -v, --version             Show version and exit',
    '      --continue            Resume the latest session for this project',
    '      --session <id>        Use a specific session id',
    '      --plan                Start directly in Plan Mode',
    '      --agent-teams         Enable Agent Teams',
    '      --classic             Use the classic readline UI',
    '      --dump-system-prompt  Print the full system prompt and exit',
    '',
    'Configuration:',
    '  ~/.q-code/config.toml     Global config',
    '  .q-code/config.toml       Project config',
    '  .env                      Project env fallback',
    '',
    'Examples:',
    '  q-code',
    '  q-code --continue',
    '  q-code --session my-task --plan'
  ].join('\n')
}

function getPackageJsonCandidates(startDir: string): string[] {
  const candidates: string[] = []
  let current = startDir

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) candidates.push(candidate)

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return candidates
}
