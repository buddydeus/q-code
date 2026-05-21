import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeFetchUrl, validatePublicHttpUrl } from '../../src/tools/safe-fetch'

describe('safe fetch URL validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects non-http protocols and local/private addresses', async () => {
    await expect(validatePublicHttpUrl('file:///etc/passwd')).rejects.toThrow('仅允许')
    await expect(validatePublicHttpUrl('http://localhost:3000')).rejects.toThrow('本地地址')
    await expect(validatePublicHttpUrl('http://127.0.0.1:3000')).rejects.toThrow('非公网地址')
    await expect(validatePublicHttpUrl('http://[::1]:3000')).rejects.toThrow('非公网地址')
    await expect(validatePublicHttpUrl('http://[fc00::1]')).rejects.toThrow('非公网地址')
    await expect(validatePublicHttpUrl('http://[2001:db8::1]')).rejects.toThrow('非公网地址')
    await expect(validatePublicHttpUrl('http://169.254.169.254/latest')).rejects.toThrow('非公网地址')
    await expect(validatePublicHttpUrl('http://10.0.0.1')).rejects.toThrow('非公网地址')
  })

  it('validates redirect targets before following them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' }
      })
    )

    await expect(safeFetchUrl('https://93.184.216.34/start')).rejects.toThrow('非公网地址')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
