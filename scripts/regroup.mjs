/**
 * 两级分区迁移（D-034），v2：文件与数据库一起改。
 *
 * v1 只改数据库，文件头里的 domain 没改；下次 repair 会按文件头把数据库改回去。
 * 这里改成：找到文件 → 改文件头 domain → 移到新路径 → 更新数据库。
 *
 *   node scripts/regroup.mjs --home <库路径> [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import { layout } from '../src/config.mjs'
import { openDb } from '../src/db.mjs'
import { blockFilePath, domainSegments } from '../src/blocks.mjs'

const args = process.argv.slice(2)
const homeIndex = args.indexOf('--home')
const home = homeIndex >= 0 ? args[homeIndex + 1] : layout().home
const dry = args.includes('--dry')

const MAP = {
  工具: '工具/GG修改器',
  default: '示例/种子',
}

const l = layout(home)
const db = openDb(l.db)
const rows = db.prepare('SELECT id, domain, path FROM blocks WHERE deleted_at IS NULL').all()

function findFile(id) {
  const stack = [l.blocks]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.name === `${id}.md`) return abs
    }
  }
  return null
}

let moved = 0
for (const row of rows) {
  const target = MAP[row.domain]
  if (!target) continue

  const current = (row.path && fs.existsSync(row.path)) ? row.path : findFile(row.id)
  if (!current) { console.log(`跳过（找不到文件）${row.id}`); continue }

  const raw = fs.readFileSync(current, 'utf8')
  const updated = raw.replace(/^domain:\s*.*$/m, `domain: ${target}`)
  const nextPath = blockFilePath(home, { ...row, domain: target })

  console.log(`${dry ? '[dry] ' : ''}${row.id}  ${row.domain} → ${target}`)
  if (dry) continue

  fs.mkdirSync(path.dirname(nextPath), { recursive: true })
  fs.writeFileSync(nextPath, updated, 'utf8')
  if (path.resolve(current) !== path.resolve(nextPath)) fs.rmSync(current, { force: true })
  db.prepare('UPDATE blocks SET domain=?, path=?, modified_at=? WHERE id=?')
    .run(target, nextPath, new Date().toISOString(), row.id)
  moved += 1
}

// 清掉迁移后留下的空目录
function pruneEmpty(dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name))
  }
  try {
    if (fs.readdirSync(dir).length === 0 && path.resolve(dir) !== path.resolve(l.blocks)) fs.rmdirSync(dir)
  } catch { /* ignore */ }
}
if (!dry) pruneEmpty(l.blocks)

db.close()
console.log(dry ? '只预览，未改动' : `已迁移 ${moved} 条`)
