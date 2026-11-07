/**
 * 共判队列（KB7，R0 只做队列与裁决，不做版本回滚）。
 *
 * 候选块不进 blocks/，只躺在 candidates 表里；人裁决后才落盘。
 * 一次给一批（默认 7 条），不逐条弹。
 */
import { upsertBlock } from './db.mjs'
import { writeBlockFile } from './blocks.mjs'
import { clip } from './text.mjs'
import { contentHash } from './ids.mjs'

export function enqueue(db, block, reason = '') {
  const info = db.prepare(`INSERT INTO candidates(block_id, payload, reason, created_at, status)
    VALUES (?,?,?,?, 'pending')`).run(block.id, JSON.stringify(block), reason, block.created_at)
  return Number(info.lastInsertRowid)
}

export function pending(db, limit = 7) {
  return db.prepare(`SELECT seq, block_id, payload, reason, created_at FROM candidates
    WHERE status = 'pending' ORDER BY seq LIMIT ?`).all(limit)
}

export function pendingCount(db) {
  return db.prepare("SELECT count(*) AS n FROM candidates WHERE status='pending'").get().n
}

/** 接受：写盘 + 进索引 + 标记候选已决。overrides 支持改写标题/简介/正文。 */
export function accept(db, home, seq, overrides = {}) {
  const row = db.prepare('SELECT * FROM candidates WHERE seq = ?').get(seq)
  if (!row) throw new Error(`候选不存在：${seq}`)
  if (row.status !== 'pending') throw new Error(`候选 ${seq} 已经裁决过了（${row.status}）`)
  const block = { ...JSON.parse(row.payload), ...overrides }
  if (overrides.body !== undefined) block.content_hash = contentHash(overrides.body)
  block.modified_at = new Date().toISOString()
  const abs = writeBlockFile(home, block)
  upsertBlock(db, { ...block, path: abs })
  db.prepare("UPDATE candidates SET status='accepted' WHERE seq=?").run(seq)
  return { ...block, path: abs }
}

export function reject(db, seq) {
  const row = db.prepare('SELECT status FROM candidates WHERE seq = ?').get(seq)
  if (!row) throw new Error(`候选不存在：${seq}`)
  if (row.status !== 'pending') throw new Error(`候选 ${seq} 已经裁决过了（${row.status}）`)
  db.prepare("UPDATE candidates SET status='rejected' WHERE seq=?").run(seq)
  return true
}

/** 给终端看的一行摘要。 */
export function describe(row, index) {
  const block = JSON.parse(row.payload)
  const tag = block.type === 'experience' ? '经验' : '知识'
  return [
    `${index}. [${tag}] ${block.title}`,
    `   id ${block.id} ｜ 来源 ${block.source || '（无）'} ｜ ${block.area}`,
    `   简介 ${clip(block.summary, 60) || '（空）'}`,
  ].join('\n')
}
