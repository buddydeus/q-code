import type { TokenBudgetSnapshot } from './token-budget'

export class CompactionCircuitBreaker {
  private consecutiveFailures = 0

  constructor(private readonly maxFailures = 3) {}

  get failures(): number {
    return this.consecutiveFailures
  }

  get isOpen(): boolean {
    return this.consecutiveFailures >= this.maxFailures
  }

  shouldAttempt(snapshot: TokenBudgetSnapshot): boolean {
    if (this.isOpen) return false
    return snapshot.state === 'error' || snapshot.state === 'blocking'
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
  }

  recordFailure(): void {
    this.consecutiveFailures++
  }
}
