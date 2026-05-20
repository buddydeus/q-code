import type { Key } from 'ink'

type EditingKey = Pick<Key, 'backspace' | 'ctrl' | 'delete'>

const BACKSPACE_SEQUENCES = new Set(['\b', '\x1b\b', '\x7f', '\x1b\x7f'])

export function shouldBackspace(value: string, key: EditingKey, rawInput?: string): boolean {
  if (key.backspace) return true
  if (key.ctrl && value === 'h') return true
  return key.delete && rawInput !== undefined && BACKSPACE_SEQUENCES.has(rawInput)
}

export function shouldDeleteForward(key: EditingKey, rawInput?: string): boolean {
  if (!key.delete) return false
  return rawInput === undefined || !BACKSPACE_SEQUENCES.has(rawInput)
}
