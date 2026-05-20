import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import fg from 'fast-glob'
import type { ToolDefinition, ToolExecutionContext } from './registry'

export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询指定城市的天气信息',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如"北京"、"上海"' }
    },
    required: ['city'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    const data: Record<string, string> = {
      北京: '晴，15-25°C，东南风 2 级',
      上海: '多云，18-22°C，西南风 3 级',
      深圳: '阵雨，22-28°C，南风 2 级'
    }
    return data[city] || `${city}：暂无数据`
  }
}

export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' }
    },
    required: ['url'],
    additionalProperties: false
  },
  isConcurrencySafe: true, // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500, // 网页通常很长，截断兜底
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) return `请求失败：HTTP ${res.status}`
      const html = await res.text()
      return (
        html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() || '页面无文本内容'
      )
    } catch (err: any) {
      return `抓取失败：${err.message}`
    }
  }
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async (
    { pattern, path = '.' }: { pattern: string; path?: string },
    context: ToolExecutionContext
  ) => {
    const results = await fg(pattern, {
      cwd: resolve(context.cwd, path),
      ignore: ['node_modules/**', '.git/**'],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false
    })
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`
    return results.sort().join('\n')
  }
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async (
    { pattern, path = '.' }: { pattern: string; path?: string },
    context: ToolExecutionContext
  ) => {
    const baseDir = resolve(context.cwd, path)
    const regex = new RegExp(pattern, 'i')
    const matches: string[] = []
    const SKIP = new Set(['node_modules', '.git', 'dist'])
    const BIN_EXT = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock'])

    function searchFile(filePath: string) {
      if (matches.length >= 50) return
      const ext = filePath.slice(filePath.lastIndexOf('.'))
      if (BIN_EXT.has(ext)) return

      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch {
        return
      }

      const lines = content.split('\n')
      const rel = relative(baseDir, filePath)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`)
          if (matches.length >= 50) return
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const name of entries) {
        if (SKIP.has(name)) continue
        const full = join(dir, name)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) walk(full)
          else searchFile(full)
        } catch {
          /* skip */
        }
      }
    }

    const stat = statSync(baseDir)
    if (stat.isFile()) {
      searchFile(baseDir)
    } else {
      walk(baseDir)
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`
    const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : ''
    return matches.join('\n') + suffix
  }
}

let previewServer: Server | null = null

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8', // 让浏览器把 .tsx 当 JS 加载
  '.ts': 'application/javascript; charset=utf-8'
  // ...
}

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: { port: { type: 'number' } },
    required: [],
    additionalProperties: false
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async (
    { port = 8080 }: { port?: number } = {},
    context: ToolExecutionContext
  ) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`
    const root = resolve(context.cwd, 'app')
    if (!existsSync(root)) return '错误：app/ 目录不存在'

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split('?')[0] || '/').replace(/\/$/, '/index.html')
      const filePath = join(root, urlPath === '/' ? '/index.html' : urlPath)
      try {
        if (!filePath.startsWith(root)) {
          res.writeHead(403)
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        })
        res.end(readFileSync(filePath))
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })

    return new Promise<string>((resolve) => {
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}`)
      })
    })
  }
}
