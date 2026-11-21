#!/usr/bin/env node
/**
 * 检索规模基准：造合成块，测 searchBlocks / consult 的 p50、p95。
 *
 * 用法：
 *   node scripts/bench-search.mjs                 # 默认 5000 条
 *   node scripts/bench-search.mjs --count 10000
 *   node scripts/bench-search.mjs --count 100000 --queries 30
 *   node scripts/bench-search.mjs --keep          # 保留临时库，便于复查
 *
 * 注意：只造索引行，不写 Markdown 文件，测的是"查询索引"的成本；
 * 写入成本（文件 + 索引）另算，不在这个脚本里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock, searchBlocks, counts } from '../src/db.mjs'
import { consult, indexSummary } from '../src/consult.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const count = Math.max(100, Number(arg('count', 5000)))
const queryCount = Math.max(5, Number(arg('queries', 20)))
const keep = process.argv.includes('--keep')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bench-'))
initHome(home)
const db = openDb(layout(home).db)

const domains = ['工具/DSH', '网络/HTTP', '数据/编码', '数据/检索', 'Windows/路径', '业务/流程']
const vocab = ['索引', '分词', '备份', '并发', '路径', '缓存', '插件', '协议', '注入', '检索', '数据库', '压缩']
const now = new Date().toISOString()

console.log(`造数据：${count} 条 → ${home}`)
const insertStart = Date.now()
for (let i = 0; i < count; i += 1) {
  const w1 = vocab[i % vocab.length]
  const w2 = vocab[(i * 7 + 3) % vocab.length]
  const id = `bench${String(i).padStart(7, '0')}`
  upsertBlock(db, {
    id,
    type: 'knowledge',
    kind: 'concept',
    title: `${w1} 与 ${w2} 的第 ${i} 条`,
    summary: `关于${w1}和${w2}的一句话简介，编号 ${i}`,
    body: `这是第 ${i} 条合成正文。涉及${w1}、${w2}、${vocab[(i * 5) % vocab.length]}。`.repeat(4),
    path: path.join(home, 'blocks', domains[i % domains.length], 'knowledge', `${id}.md`),
    domain: domains[i % domains.length],
    created_at: now,
    modified_at: now,
  })
}
console.log(`造数据耗时：${((Date.now() - insertStart) / 1000).toFixed(1)}s`)

const queries = []
for (let i = 0; i < queryCount; i += 1) {
  const a = vocab[i % vocab.length]
  const b = vocab[(i * 5 + 1) % vocab.length]
  queries.push(i % 3 === 0 ? `${a} ${b}` : a)
}

function percentile(values, p) {
  const sorted = [...values].sort((x, y) => x - y)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index]
}

const searchTimes = []
const consultTimes = []
const summaryTimes = []
const countTimes = []
let searchRows = 0
let consultChars = 0

for (const query of queries) {
  const t0 = performance.now()
  const rows = searchBlocks(db, query, { limit: 10 })
  searchTimes.push(performance.now() - t0)
  searchRows += rows.length

  const t1 = performance.now()
  const result = consult(db, query, { limit: 5 })
  consultTimes.push(performance.now() - t1)
  const t2 = performance.now()
  indexSummary(db)
  summaryTimes.push(performance.now() - t2)
  const t3 = performance.now()
  counts(db)
  countTimes.push(performance.now() - t3)
  consultChars += (result.summary?.length ?? 0) + result.rows.reduce((sum, row) => sum + row.title.length + (row.summary?.length ?? 0), 0)
}

const stat = (times) => ({
  p50: percentile(times, 50).toFixed(2),
  p95: percentile(times, 95).toFixed(2),
  mean: (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
})

const s = stat(searchTimes)
const c = stat(consultTimes)
const m = stat(summaryTimes)
const n = stat(countTimes)
const dbBytes = fs.statSync(layout(home).db).size

console.log('')
console.log('| 指标 | 值 |')
console.log('|---|---|')
console.log(`| 块数 | ${count} |`)
console.log(`| 索引文件 | ${(dbBytes / 1024 / 1024).toFixed(2)} MB |`)
console.log(`| searchBlocks p50 / p95 / mean | ${s.p50} / ${s.p95} / ${s.mean} ms |`)
console.log(`| consult（含索引摘要）p50 / p95 / mean | ${c.p50} / ${c.p95} / ${c.mean} ms |`)
console.log(`| 其中 indexSummary p50 / p95 | ${m.p50} / ${m.p95} ms |`)
console.log(`| 其中 counts p50 / p95 | ${n.p50} / ${n.p95} ms |`)
console.log(`| 平均命中条数（limit 10） | ${(searchRows / queries.length).toFixed(1)} |`)
console.log(`| consult 平均返回字符数 | ${Math.round(consultChars / queries.length)} |`)
console.log(`| 查询数 | ${queries.length} |`)

db.close()
if (keep) console.log(`\n临时库保留在：${home}`)
else fs.rmSync(home, { recursive: true, force: true })

