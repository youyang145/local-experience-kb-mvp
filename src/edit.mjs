/**
 * 编辑块（界面用）。
 *
 * 只允许改内容，不允许改 id / 领域 / 类型：
 * 领域或类型一变，文件就得搬家，映射、孤儿、经验归属全要跟着重算——
 * 那是"移动"操作，不该藏在编辑框里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getBlock, upsertBlock, softDelete } from './db.mjs'
import { readBlockFile, writeBlockFile, moveToTrash } from './blocks.mjs'
import { normalizeExp, orphanExperiences } from './experience.mjs'
import { clip } from './text.mjs'
import { contentHash } from './ids.mjs'

const COMMON = ['title', 'summary', 'source', 'body']
const EXP = ['claim', 'scope', 'limits']

export function updateBlock(db, home, id, patch) {
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  if (patch.domain && patch.domain !== row.domain) throw new Error('领域不能在编辑里改')
  if (patch.type && patch.type !== row.type) throw new Error('类型不能在编辑里改')

  const meta = readBlockFile(row.path)
  for (const key of COMMON) {
    if (patch[key] !== undefined) meta[key] = String(patch[key])
  }
  if (row.type === 'knowledge') {
    if (patch.kind !== undefined) meta.kind = String(patch.kind)
    if (patch.tags !== undefined) {
      meta.tags = Array.isArray(patch.tags)
        ? patch.tags
        : String(patch.tags).split(',').map((s) => s.trim()).filter(Boolean)
    }
  }
  if (row.type === 'experience') {
    const exp = normalizeExp(meta)
    for (const key of EXP) {
      if (patch[key] !== undefined) exp[key] = String(patch[key])
    }
    if (patch.claim !== undefined) {
      exp.claim = String(patch.claim)
      exp.title = clip(exp.claim, 60)
    }
    Object.assign(meta, exp)
  }

  meta.modified_at = new Date().toISOString()
  meta.version = Number(meta.version ?? 1) + 1
  meta.editor = 'human'
  if (patch.body !== undefined) meta.content_hash = contentHash(String(patch.body))

  const abs = writeBlockFile(home, meta)
  if (abs !== row.path) throw new Error('内部错误：编辑不应改变文件路径')
  upsertBlock(db, { ...meta, path: abs })
  return meta
}

export function removeBlock(db, home, id) {
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  if (row.deleted_at) throw new Error('已经删过了')
  moveToTrash(home, row.path, id)
  softDelete(db, id, new Date().toISOString())
  const orphaned = row.type === 'knowledge' ? orphanExperiences(db, home, id) : []
  return { id, orphaned }
}

/**
 * 移动块到另一个分区（搬家）。
 * 领域一变文件路径就变，所以要：写新文件 → 更新索引 → 删旧文件。
 * 只允许两级「分区/主题」；不允许移到「待分区」以外的半截名字。
 */
export function moveBlock(db, home, id, domain) {
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  const next = String(domain ?? '').trim()
  if (!/^[^/]+\/[^/]+$/.test(next)) throw new Error('分区要写成「分区/主题」两级，例如 网络/HTTP')
  if (next === row.domain) return { id, domain: next, moved: false, path: row.path }

  const block = readBlockFile(row.path)
  block.domain = next
  block.modified_at = new Date().toISOString()
  const oldPath = row.path
  const newPath = writeBlockFile(home, block)
  db.prepare('UPDATE blocks SET domain = ?, path = ?, modified_at = ? WHERE id = ?')
    .run(next, newPath, block.modified_at, id)
  try {
    if (path.resolve(oldPath) !== path.resolve(newPath)) fs.rmSync(oldPath, { force: true })
  } catch { /* 旧文件删不掉不影响索引 */ }
  return { id, domain: next, moved: true, path: newPath }
}
