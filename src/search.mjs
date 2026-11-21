/**
 * 检索编排：索引优先，深扫兜底。
 *
 * 顺序：FTS 索引 → softSearch 兜底 → deepScan（文件级互助补全）。
 * 自适应：命中够 / 预算用完就停；只有"零命中"或"文件类查询"才启用深扫。
 *
 * 返回带 complete / coverage / strategies，调用方不许在 complete=false 时声称"找全了"。
 */
import os from 'node:os'
import { searchBlocks } from './db.mjs'
import { softSearch } from './consult.mjs'
import { deepScan } from './deepscan.mjs'

const PROFILES = {
  index: { budgetMs: 80, soft: false, deep: false },
  quick: { budgetMs: 150, soft: true, deep: true },
  balanced: { budgetMs: 400, soft: true, deep: true },
  complete: { budgetMs: 5000, soft: true, deep: true, deepComplete: true },
}

const FILE_QUERY = /(?:^|[\s/\\])[\w.-]+\.(?:png|jpe?g|webp|svg|pdf|md|txt|js|ts|py|json|ya?ml|zip|fig|psd)\b|截图|图片|设计稿|附件|文件|代码示例/i

export function isFileQuery(query) {
  return FILE_QUERY.test(String(query ?? ''))
}

function merge(lists, limit) {
  const pool = new Map()
  for (const { source, rows, weight } of lists) {
    rows.forEach((row, index) => {
      const key = row.path || row.id
      if (!pool.has(key)) pool.set(key, { row: { ...row }, score: 0, sources: new Set() })
      const entry = pool.get(key)
      entry.score += weight / (60 + index + 1)
      entry.sources.add(source)
    })
  }
  return [...pool.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.row, sources: [...entry.sources] }))
}

/**
 * @param {object} db
 * @param {string} query
 * @param {object} options
 * @param {string} options.home 深扫需要库目录；没有就只走索引
 * @param {'auto'|'index'|'deep'|'off'} [options.mode]
 * @param {'index'|'quick'|'balanced'|'complete'} [options.profile]
 * @param {number} [options.limit]
 * @param {boolean} [options.includeRefuted]
 * @param {boolean} [options.allowDeep]
 */
export async function search(db, query, {
  home = '',
  mode = 'auto',
  profile = 'balanced',
  limit = 8,
  includeRefuted = false,
  allowDeep = true,
} = {}) {
  const start = performance.now()
  const q = String(query ?? '').trim()
  if (!q || mode === 'off') {
    return { rows: [], strategies: [], complete: true, coverage: 1, elapsedMs: 0, profile, deep: null }
  }

  const cfg = PROFILES[profile] ?? PROFILES.balanced
  const lists = []
  const strategies = []

  if (mode !== 'deep') {
    const rows = searchBlocks(db, q, { limit, includeRefuted })
    lists.push({ source: 'index', rows, weight: 1 })
    strategies.push('index')

    const enough = rows.length >= Math.min(limit, 3)
    const overBudget = performance.now() - start > cfg.budgetMs * 0.6
    if (!enough && !overBudget && cfg.soft) {
      const soft = softSearch(db, q, limit)
      if (soft.length) {
        lists.push({ source: 'soft', rows: soft, weight: 0.7 })
        strategies.push('soft')
      }
    }
  }

  let deep = null
  const partial = merge(lists, limit)
  const needDeep = mode === 'deep'
    || (mode === 'auto' && allowDeep && cfg.deep && home && (partial.length === 0 || (isFileQuery(q) && partial.length < limit)))

  if (needDeep) {
    const remaining = Math.max(20, cfg.budgetMs - (performance.now() - start))
    deep = await deepScan(home, q, {
      limit,
      budgetMs: remaining,
      concurrency: Math.min(4, Math.max(1, os.cpus()?.length ?? 1)),
      complete: Boolean(cfg.deepComplete),
    })
    if (deep.hits.length) {
      lists.push({ source: 'deep', rows: deep.hits, weight: 0.5 })
      strategies.push('deep')
    }
  }

  const rows = merge(lists, limit)
  const elapsedMs = performance.now() - start
  const complete = deep ? deep.complete : elapsedMs <= cfg.budgetMs
  return {
    rows,
    strategies,
    complete,
    coverage: deep ? deep.coverage : 1,
    elapsedMs,
    profile,
    deep: deep ? { filesRead: deep.filesRead, bytes: deep.bytes, complete: deep.complete, coverage: deep.coverage } : null,
  }
}
