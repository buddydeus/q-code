export function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(
      [
        `Missing required configuration: ${name}`,
        'Set it in the environment, project .env, project .q-code/config.toml, or ~/.q-code/config.toml.',
        'Example:',
        '[openai]',
        'api_key = "sk-..."',
        'base_url = "https://api.openai.com/v1"',
        'model = "gpt-5.4"'
      ].join('\n')
    )
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

export { isFalseEnv } from './env'
