import Database from 'better-sqlite3'
import {
  BaseSqliteStorage,
  BaseSqliteStorageDriver,
  type ISqliteDatabase,
} from '@mtcute/node'

// mtcute's string shorthand currently constructs its bundled better-sqlite3 12.x
// driver, which can abort during statement cleanup on Node 24.
export class MtcuteSqliteStorageDriver extends BaseSqliteStorageDriver {
  constructor(readonly filename: string) {
    super()
  }

  _createDatabase(): ISqliteDatabase {
    const db = new Database(this.filename)
    db.pragma('journal_mode = WAL')
    return db as unknown as ISqliteDatabase
  }
}

export class MtcuteSqliteStorage extends BaseSqliteStorage {
  constructor(readonly filename: string) {
    super(new MtcuteSqliteStorageDriver(filename))
  }
}
