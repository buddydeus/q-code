import type { ModelMessage } from 'ai'

export interface Session {
  id: string
  messages: ModelMessage[]
  createdAt: number
  updatedAt: number
}

export class SessionStore {
  private sessions = new Map<string, Session>()

  create(): Session {
    const id = crypto.randomUUID()
    const session: Session = {
      id,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.sessions.set(id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  update(id: string, messages: ModelMessage[]): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.messages = messages
    session.updatedAt = Date.now()
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  delete(id: string): boolean {
    return this.sessions.delete(id)
  }
}
