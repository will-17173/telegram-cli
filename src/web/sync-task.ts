export type SyncTaskState =
  | { status: 'idle' }
  | { status: 'running'; account: string; chat_id: number; limit: number; started_at: string }
  | { status: 'done'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; synced: number }
  | { status: 'error'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; error: { code: string; message: string } }

export class SyncTaskRunner {
  private state: SyncTaskState = { status: 'idle' }

  constructor(private readonly _options: { dataDir: string }) {}

  getState(): SyncTaskState {
    return this.state
  }

  async start(_input: { account: string; chatId: number; limit: number }): Promise<{ ok: false; error: { code: string; message: string } }> {
    return { ok: false, error: { code: 'sync_not_implemented', message: 'Sync task runner is not implemented yet.' } }
  }
}
