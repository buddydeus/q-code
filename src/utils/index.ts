export function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export function normalizeBaseURL(rawBaseURL: string) {
  const url = new URL(rawBaseURL)

  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/v1'
  }

  return url.toString().replace(/\/$/, '')
}
