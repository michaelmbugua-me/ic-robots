import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DEFAULT_DB_PATH = "data/ticks.sqlite";

export class TickDatabase {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        pair TEXT,
        timestamp INTEGER,
        bid REAL,
        ask REAL,
        PRIMARY KEY (pair, timestamp, bid, ask)
      );
      CREATE INDEX IF NOT EXISTS idx_ticks_pair_time ON ticks (pair, timestamp);
      
      CREATE TABLE IF NOT EXISTS coverage (
        pair TEXT,
        day TEXT,
        from_ms INTEGER,
        to_ms INTEGER,
        updated_at TEXT,
        PRIMARY KEY (pair, day)
      );
    `);
    // Optimize for bulk writes and high-speed reads
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  insertTicks(pair, ticks) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO ticks (pair, timestamp, bid, ask)
      VALUES (?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((data) => {
      for (const t of data) {
        insert.run(pair, t.timestamp, t.bid, t.ask);
      }
    });

    transaction(ticks);
  }

  getTicks(pair, fromMs, toMs) {
    return this.db.prepare(`
      SELECT timestamp, bid, ask
      FROM ticks
      WHERE pair = ? AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC
    `).all(pair, fromMs, toMs);
  }

  saveCoverage(pair, day, fromMs, toMs) {
    this.db.prepare(`
      INSERT OR REPLACE INTO coverage (pair, day, from_ms, to_ms, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(pair, day, fromMs, toMs, new Date().toISOString());
  }

  getCoverage(pair, fromMs, toMs) {
    return this.db.prepare(`
      SELECT from_ms as "from", to_ms as "to"
      FROM coverage
      WHERE pair = ? AND from_ms <= ? AND to_ms >= ?
    `).all(pair, fromMs, toMs);
  }

  close() {
    this.db.close();
  }
}
