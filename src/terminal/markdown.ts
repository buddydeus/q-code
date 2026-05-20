export type MarkdownBlock =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; language?: string; code: string }
  | { type: 'rule' }

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }

    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/)
    if (fence) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        codeLines.push(lines[i] ?? '')
        i++
      }
      if (i < lines.length) i++
      blocks.push({
        type: 'code',
        ...(fence[1] ? { language: fence[1] } : {}),
        code: codeLines.join('\n')
      })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      blocks.push({
        type: 'heading',
        depth: heading[1]!.length,
        text: stripInlineMarkdown(heading[2]!)
      })
      i++
      continue
    }

    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        quoteLines.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n').trim() })
      continue
    }

    if (isListLine(line)) {
      const ordered = isOrderedListLine(line)
      const items: string[] = []
      while (i < lines.length && isListLine(lines[i] ?? '') && isOrderedListLine(lines[i] ?? '') === ordered) {
        items.push(stripInlineMarkdown((lines[i] ?? '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')))
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraphLines: string[] = []
    while (i < lines.length && lines[i]?.trim() && !startsBlock(lines[i] ?? '')) {
      paragraphLines.push(lines[i] ?? '')
      i++
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.map(stripInlineMarkdown).join(' ') })
  }

  return blocks
}

export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
}

function startsBlock(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^>\s?/.test(line) ||
    isListLine(line) ||
    /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
  )
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)
}

function isOrderedListLine(line: string): boolean {
  return /^\s*\d+[.)]\s+/.test(line)
}
