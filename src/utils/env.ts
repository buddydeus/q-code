export function isFalseEnv(value: string | undefined): boolean {
  return ['0', 'false', 'off', 'no'].includes((value ?? '').trim().toLowerCase())
}
