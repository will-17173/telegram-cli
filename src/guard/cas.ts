export type GuardCasResult = {
  banned: boolean
  offenses?: number
  messages?: unknown
  time_added?: string
}

export type GuardCasChecker = {
  check(userId: number): Promise<GuardCasResult>
}

type CasApiCheckerOptions = {
  fetch?: typeof fetch
  baseUrl?: string
}

export class CasApiChecker implements GuardCasChecker {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: CasApiCheckerOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.baseUrl = options.baseUrl ?? 'https://api.cas.chat'
  }

  async check(userId: number): Promise<GuardCasResult> {
    const url = new URL('/check', this.baseUrl)
    url.searchParams.set('user_id', String(userId))

    const response = await this.fetchImpl(url)
    if (!response.ok) throw new Error(`CAS check failed with HTTP ${response.status}`)

    const body = await response.json() as unknown
    if (!isRecord(body)) throw new Error('CAS check returned invalid JSON')

    if (body.ok === false && body.description === 'Record not found.') return { banned: false }
    if (body.ok !== true) throw new Error(typeof body.description === 'string' ? body.description : 'CAS check failed')
    if (!isRecord(body.result)) throw new Error('CAS check returned an invalid result')

    return {
      banned: true,
      ...(typeof body.result.offenses === 'number' ? { offenses: body.result.offenses } : {}),
      ...(hasOwn(body.result, 'messages') ? { messages: body.result.messages } : {}),
      ...(typeof body.result.time_added === 'string' ? { time_added: body.result.time_added } : {}),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
