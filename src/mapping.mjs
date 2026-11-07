/**
 * 映射寻址（KB1）：id ↔ 文件实际地址。
 *
 * 索引里的 path 是缓存，明文才是真相。`repair` 做五件事：
 *   1. 磁盘上有、索引里没有 → 收编
 *   2. 索引里的 path 与文件实际位置不一致 → 重映射（改名/挪目录后仍指对）
 *   3. 同一个 id 出现在两个文件 → 保留索引认可的那份，另一份隔离到 _conflicts
 *   4. 索引里有、磁盘上没有 → 标记 missing（只报，不删）
 *   5. 经验引用的知识块不见了 → 标 orphaned（D-027），留在领域里不连坐
 */
import path from 'node:path'
import { listBlockFiles, readBlockFile, moveToConflicts, writeBlockFile } from './blocks.mjs'
import { upsertBlock, getBlock } from './db.mjs'
import { normalizeExp } from './experience.mjs'

export function scan(home) {
  return listBlockFiles(home).map((abs) => {
    try {
      return { abs, block: readBlockFile(abs) }
    } catch (error) {
      return { abs, error: error.message }
    }
  })
}

export function repair(db, home) {
  const report = { adopted: [], remapped: [], conflicts: [], missing: [], broken: [], orphaned: [] }

  const byId = new Map()
  for (const item of scan(home)) {
    if (item.error) { report.broken.push({ path: item.abs, error: item.error }); continue }
    const { id } = item.block
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(item)
  }

  const kept = new Map()
  let conflictSeq = 0
  for (const [id, items] of byId) {
    const row = getBlock(db, id)
    let winner = items[0]
    if (items.length > 1) {
      const registered = row ? items.find((it) => path.resolve(it.abs) === path.resolve(row.path)) : undefined
      winner = registered ?? [...items].sort((a, b) => a.abs.localeCompare(b.abs))[0]
      for (const loser of items) {
        if (loser === winner) continue
        conflictSeq += 1
        const moved = moveToConflicts(home, loser.abs, `-conflict${conflictSeq}`)
        report.conflicts.push({ id, kept: winner.abs, moved })
      }
    }
    kept.set(id, winner)

    const samePath = row && path.resolve(row.path) === path.resolve(winner.abs)
    if (!row) {
      upsertBlock(db, { ...winner.block, path: winner.abs })
      report.adopted.push(id)
    } else if (!samePath) {
      upsertBlock(db, { ...winner.block, path: winner.abs })
      report.remapped.push({ id, from: row.path, to: winner.abs })
    }
  }

  for (const row of db.prepare('SELECT id, path FROM blocks WHERE deleted_at IS NULL').all()) {
    if (!kept.has(row.id)) report.missing.push({ id: row.id, path: row.path })
  }

  // 孤儿：经验引用的知识块不在库中，给经验打标记并重写块头。
  for (const [id, item] of kept) {
    if (item.block.type !== 'experience') continue
    const exp = normalizeExp(item.block)
    if (!exp.primary_knowledge) continue
    if (kept.has(exp.primary_knowledge)) continue
    exp.orphaned = true
    exp.primary_knowledge = ''
    const abs = writeBlockFile(home, exp)
    upsertBlock(db, { ...exp, path: abs })
    report.orphaned.push(id)
  }

  return report
}
