/**
 * 编辑块（界面用）。
 *
 * 只允许改内容，不允许改 id / 领域 / 类型：
 * 领域或类型一变，文件就得搬家，映射、孤儿、经验归属全要跟着重算——
 * 那是"移动"操作，不该藏在编辑框里。
 */
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
