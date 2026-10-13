// Synchronous acquisition keeps all in-process session operations atomic.
export class AccountReservations {
  private readonly owners = new Map<string, symbol>()

  isBusy(account?: string | null): boolean {
    return account == null ? this.owners.size > 0 : this.owners.has(account)
  }

  reserve(account: string): (() => void) | null {
    if (this.owners.has(account)) return null
    const owner = Symbol(account)
    this.owners.set(account, owner)
    return () => {
      if (this.owners.get(account) === owner) this.owners.delete(account)
    }
  }
}
