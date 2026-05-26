import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.Q_CODE_HOME?.trim()) {
  process.env.Q_CODE_HOME = mkdtempSync(join(tmpdir(), 'q-code-vitest-home-'))
}

mkdirSync(process.env.Q_CODE_HOME, { recursive: true })
