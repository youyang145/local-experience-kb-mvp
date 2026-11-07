/**
 * 检索契约（golden set）。
 *
 * 为什么不写死 id：id 含随机盐，换一次播种就变；标题是稳定的，所以期望按标题比对。
 * 为什么自建语料：真实库会变，契约要能脱离数据独立跑——语料和查询都在这份 JSON 里。
 *
 * 用法：
 *   kb eval                    在临时库里跑（不碰你的数据）
 *   kb eval --home <目录>       在指定库上跑（要求该库有同样的标题）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initHome, layout } from './config.mjs'
import { openDb, upsertBlock, searchBlocks } from './db.mjs'
import { buildCandidate } from './capture.mjs'
import { writeBlockFile } from './blocks.mjs'

export function loadGolden(file) {
  const golden = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(golden.corpus) || !Array.isArray(golden.queries)) {
    throw new Error('golden 文件格式不对：需要 corpus 与 queries')
  }
  return golden
}

export function seedCorpus(db, home, corpus) {
  for (const [index, item] of corpus.entries()) {
    const block = buildCandidate({
      title: item.title,
      body: item.body ?? '',
      domain: item.domain ?? 'default',
      source: item.source ?? '',
    }, { salt: `golden-${index}` })
    const abs = writeBlockFile(home, block)
    upsertBlock(db, { ...block, path: abs })
  }
  return corpus.length
}

/** 跑一遍契约，返回逐条结果与召回率。 */
export function runGolden(db, golden, { limit } = {}) {
  const topK = limit ?? golden.k ?? 10
  const rows = []
  let hit = 0
  let total = 0
  for (const query of golden.queries) {
    const expected = query.expect ?? []
    const found = searchBlocks(db, query.q, { limit: topK }).map((row) => row.title)
    const missing = expected.filter((title) => !found.includes(title))
    hit += expected.length - missing.length
    total += expected.length
    rows.push({ q: query.q, note: query.note ?? '', expected, found, missing, ok: missing.length === 0 })
  }
  return { rows, hit, total, recall: total ? hit / total : 1, topK }
}

function tempDir() {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kb-eval-'))
  } catch {
    return fs.mkdtempSync(path.join(process.cwd(), '.eval-tmp-'))
  }
}

/** 在临时库里播种语料并跑契约，跑完删掉临时库。 */
export function evalInTemp(golden) {
  const dir = tempDir()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    seedCorpus(db, dir, golden.corpus)
    const report = runGolden(db, golden)
    db.close()
    return report
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* 句柄未释放就留给系统清理 */ }
  }
}

/** 在已有库上跑契约。 */
export function evalOnHome(home, golden) {
  const db = openDb(layout(home).db)
  try {
    return runGolden(db, golden)
  } finally {
    db.close()
  }
}

export function formatReport(report) {
  const lines = []
  for (const row of report.rows) {
    const mark = row.ok ? '✔' : '✘'
    lines.push(`${mark} ${row.q}${row.note ? `（${row.note}）` : ''}`)
    if (!row.ok) {
      lines.push(`    缺：${row.missing.join('、')}`)
      lines.push(`    实际：${row.found.join('、') || '（空）'}`)
    }
  }
  lines.push('')
  lines.push(`召回 ${report.hit}/${report.total} = ${(report.recall * 100).toFixed(1)}%（top ${report.topK}）`)
  return lines.join('\n')
}
