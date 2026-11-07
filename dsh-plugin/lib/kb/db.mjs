/**
 * 元数据索引（SQLite）。KB0 的"索引"半身，正文永远是磁盘上的 .md 文件。
 *
 * 原则：索引可丢弃。`kb repair` 能从 blocks/ 下的明文完整重建它。
 * 表结构变更时直接重建（索引不是数据），所以这里带一个 schema 版本判断。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { indexTokens, queryExpression } from './text.mjs'

const SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body_plain TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'default',
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  editor TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'unverified',
  tier TEXT NOT NULL DEFAULT 'main',
  primary_knowledge TEXT NOT NULL DEFAULT '',
  orphaned INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS blocks_path ON blocks(path);
CREATE INDEX IF NOT EXISTS blocks_type ON blocks(type);
CREATE INDEX IF NOT EXISTS blocks_domain ON blocks(domain);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  body_tok,
  tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS candidates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS proposals (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  proposed_claim TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT
);
`

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name))
}

function currentSchema(db) {
  if (!tableExists(db, 'meta')) return 0
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()
  return row ? Number(row.value) : 0
}

export function openDb(file, { create = true } = {}) {
  if (!create && !fs.existsSync(file)) throw new Error(`索引不存在：${file}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')

  const version = currentSchema(db)
  // 表结构升级时整库丢掉（索引只是缓存），由 kb repair 从明文重建。
  if (tableExists(db, 'blocks') && version !== SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS candidates; DROP TABLE IF EXISTS meta;')
  }
  db.exec(SCHEMA)
  // 旧库补列，不重建（重建会丢索引，虽可 repair，但没必要）
  const columns = db.prepare('PRAGMA table_info(blocks)').all().map((col) => col.name)
  if (!columns.includes('tags')) db.exec("ALTER TABLE blocks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
  db.prepare("INSERT INTO meta(key, value) VALUES('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION))
  return db
}

function indexRow(db, block, rowid) {
  const tags = Array.isArray(block.tags) ? block.tags.join(' ') : ''
  const bodyTok = indexTokens(`${block.title}\n${block.summary}\n${tags}\n${block.body || ''}`)
  if (rowid) db.prepare('DELETE FROM fts WHERE rowid = ?').run(rowid)
  db.prepare('INSERT INTO fts(rowid, id, title, summary, body_tok) VALUES (?,?,?,?,?)')
    .run(rowid, block.id, block.title ?? '', block.summary ?? '', bodyTok)
}

/** 写入或更新一条块的元数据与全文索引。 */
export function upsertBlock(db, block) {
  const existing = db.prepare('SELECT rowid FROM blocks WHERE id = ?').get(block.id)
  const values = [
    block.type ?? 'knowledge',
    block.kind ?? '',
    block.title ?? '',
    block.summary ?? '',
    block.body ?? '',
    block.path,
    block.domain ?? block.area ?? 'default',
    JSON.stringify(Array.isArray(block.tags) ? block.tags : []),
    block.source ?? '',
    block.created_at,
    block.modified_at ?? block.created_at,
    block.version ?? 1,
    block.editor ?? 'local',
    block.status ?? 'unverified',
    block.tier ?? 'main',
    block.primary_knowledge ?? '',
    block.orphaned ? 1 : 0,
    block.content_hash ?? '',
  ]
  if (existing) {
    db.prepare(`UPDATE blocks SET type=?, kind=?, title=?, summary=?, body_plain=?, path=?, domain=?,
      tags=?, source=?, created_at=?, modified_at=?, version=?, editor=?, status=?, tier=?,
      primary_knowledge=?, orphaned=?, content_hash=?, deleted_at=NULL
      WHERE id=?`).run(...values, block.id)
    indexRow(db, block, existing.rowid)
    return existing.rowid
  }
  const info = db.prepare(`INSERT INTO blocks(type, kind, title, summary, body_plain, path, domain,
    tags, source, created_at, modified_at, version, editor, status, tier, primary_knowledge, orphaned,
    content_hash, id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values, block.id)
  const rowid = Number(info.lastInsertRowid)
  indexRow(db, block, rowid)
  return rowid
}

export function getBlock(db, id) {
  return db.prepare('SELECT rowid, * FROM blocks WHERE id = ?').get(id) ?? null
}

export function listBlocks(db, { limit = 50, type, status, domain, includeDeleted = false } = {}) {
  const where = []
  const args = []
  if (!includeDeleted) where.push('deleted_at IS NULL')
  if (type) { where.push('type = ?'); args.push(type) }
  if (status) { where.push('status = ?'); args.push(status) }
  if (domain) { where.push("(domain = ? OR domain LIKE ? || '/%')"); args.push(domain, domain) }
  const sql = `SELECT id, type, kind, title, summary, path, domain, source, created_at, modified_at,
    version, status, tier, orphaned, deleted_at FROM blocks
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT ?`
  return db.prepare(sql).all(...args, limit)
}

/**
 * 全文检索：返回 id/title/summary/来源/领域，不返回正文（三级读取的第一层）。
 * 默认排除被推翻的经验；includeRefuted 打开时它们才出现（当反例看）。
 */
export function searchBlocks(db, query, { limit = 10, includeRefuted = false } = {}) {
  const statusFilter = includeRefuted ? '' : " AND NOT (b.type='experience' AND b.status='refuted')"
  const expr = queryExpression(query)
  if (expr) {
    const rows = db.prepare(`SELECT b.id, b.type, b.kind, b.title, b.summary, b.source, b.path,
      b.domain, b.status, b.tier, bm25(fts) AS score
      FROM fts JOIN blocks b ON b.rowid = fts.rowid
      WHERE fts MATCH ? AND b.deleted_at IS NULL${statusFilter}
      ORDER BY score LIMIT ?`).all(expr, limit)
    return rows.length ? rows : fallbackLike(db, query, limit, includeRefuted)
  }
  return fallbackLike(db, query, limit, includeRefuted)
}

/** 单字查询与 FTS 不命中时的兜底：标题/简介/正文 LIKE。1 万条量级可接受。 */
export function fallbackLike(db, query, limit = 10, includeRefuted = false) {
  const like = `%${String(query).trim()}%`
  const statusFilter = includeRefuted ? '' : " AND NOT (type='experience' AND status='refuted')"
  return db.prepare(`SELECT id, type, kind, title, summary, source, path, domain, status, tier, 0 AS score
    FROM blocks
    WHERE deleted_at IS NULL AND (title LIKE ? OR summary LIKE ? OR body_plain LIKE ?)${statusFilter}
    ORDER BY created_at DESC LIMIT ?`).all(like, like, like, limit)
}

export function softDelete(db, id, when) {
  const row = getBlock(db, id)
  if (!row) return null
  db.prepare('UPDATE blocks SET deleted_at = ? WHERE id = ?').run(when, id)
  db.prepare('DELETE FROM fts WHERE rowid = ?').run(row.rowid)
  return row
}

export function setStatus(db, id, status) {
  db.prepare('UPDATE blocks SET status = ? WHERE id = ?').run(status, id)
}

/** 把引用了某知识块的经验标成孤儿（知识块被删时调用）。 */
export function markOrphansOf(db, knowledgeId) {
  return db.prepare(`UPDATE blocks SET orphaned = 1, primary_knowledge = ''
    WHERE type='experience' AND primary_knowledge = ? AND deleted_at IS NULL`).run(knowledgeId).changes
}

export function orphans(db) {
  return db.prepare(`SELECT id, title, domain, path FROM blocks
    WHERE type='experience' AND orphaned = 1 AND deleted_at IS NULL`).all()
}

export function counts(db) {
  const one = (sql) => db.prepare(sql).get().n
  return {
    blocks: one('SELECT count(*) AS n FROM blocks WHERE deleted_at IS NULL'),
    knowledge: one("SELECT count(*) AS n FROM blocks WHERE deleted_at IS NULL AND type='knowledge'"),
    experience: one("SELECT count(*) AS n FROM blocks WHERE deleted_at IS NULL AND type='experience'"),
    probation: one("SELECT count(*) AS n FROM blocks WHERE deleted_at IS NULL AND type='experience' AND tier='probation' AND status != 'refuted'"),
    refuted: one("SELECT count(*) AS n FROM blocks WHERE deleted_at IS NULL AND type='experience' AND status='refuted'"),
    pending: one("SELECT count(*) AS n FROM candidates WHERE status='pending'"),
    proposals: one("SELECT count(*) AS n FROM proposals WHERE status='pending'"),
    deleted: one('SELECT count(*) AS n FROM blocks WHERE deleted_at IS NOT NULL'),
  }
}
