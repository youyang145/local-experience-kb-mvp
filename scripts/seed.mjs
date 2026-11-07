/**
 * 演示/压测用的种子脚本：造 N 条笔记，走的是和 CLI 完全相同的写入路径。
 *
 *   node scripts/seed.mjs --count 100 --home "%USERPROFILE%\kb-seed"
 */
import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile } from '../src/blocks.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const count = Number(arg('count', '100'))
const home = arg('home', layout().home)
const domain = arg('domain', 'default')

const topics = [
  ['SQLite 全文检索', 'FTS5 的 trigram 分词对两字词无效，需要预切二元组。', 'https://www.sqlite.org/fts5.html'],
  ['Windows 路径长度', '超过 260 字符的路径要开长路径支持，否则备份工具会失败。', ''],
  ['pnpm store 隔离', '把 store-dir 指到工作区，就能绕开沙箱的写限制。', ''],
  ['Markdown 块头', 'YAML front matter 用 --- 包起来，正文跟在后面。', ''],
  ['知识库的记账', '每次使用记 used，成功再记 succeeded，人票权重最高。', ''],
  ['映射寻址', 'id 与文件路径分开存，文件搬家后跑 repair 重映射。', ''],
  ['共判批次', '一次最多给七条候选，避免逐条打断。', ''],
]

initHome(home)
const db = openDb(layout(home).db)
for (let i = 0; i < count; i += 1) {
  const [topic, text, source] = topics[i % topics.length]
  const title = `${topic} #${i + 1}`
  const body = `${text}\n\n这是第 ${i + 1} 条演示数据，用于验证冷启动与检索。`
  const block = buildCandidate({ title, body, source, domain }, { salt: `seed-${i}` })
  const abs = writeBlockFile(home, block)
  upsertBlock(db, { ...block, path: abs })
}
db.close()
console.log(`已写入 ${count} 条到 ${home}`)

