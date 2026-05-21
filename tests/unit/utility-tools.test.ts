import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { resolvePreviewFilePath } from '../../src/tools/utility-tools'

describe('start_preview path resolution', () => {
  const root = resolve('/tmp/project/app')

  it('resolves normal app paths inside the app root', () => {
    expect(resolvePreviewFilePath(root, '/')).toBe(resolve(root, 'index.html'))
    expect(resolvePreviewFilePath(root, '/assets/app.js?cache=1')).toBe(
      resolve(root, 'assets/app.js')
    )
  })

  it('blocks encoded and raw traversal outside the app root', () => {
    expect(resolvePreviewFilePath(root, '/../secret.txt')).toBeNull()
    expect(resolvePreviewFilePath(root, '/%2e%2e/secret.txt')).toBeNull()
    expect(resolvePreviewFilePath(root, '/%ZZ')).toBeNull()
  })
})
