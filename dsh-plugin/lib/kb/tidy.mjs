/**
 * 整理员（算法版，0 token）。
 *
 * 只做算法擅长的机械活：找变更、抽摘要、查重复、算关联候选、生成任务包。
 * 不写经验、不改语义、不调用模型——AI 部分等插件外壳再补。
 *
 * 输出：报告 + <kb-home>/_tidy/tasks.json（给未来 AI 的任务包）
 * --apply 只做一件安全的事：给"简介为空"的块补抽取式摘要。
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexTokens } from './text.mjs'
import { readBlockFile, writeBlockFile } from './blocks.mjs'
import { upsertBlock } from './db.mjs'

const TIDY_DIR = '_tidy'
const INDEX_CHARS = 400

function tidyPaths(home) {
  const dir = path.join(home, TIDY_DIR)
  return {
    dir,
    state: path.join(dir, 'state.json'),
    report: path.join(dir, 'report.json'),
    tasks: path.join(dir, 'tasks.json'),
  }
}

export function loadTidyState(home) {
  const { state } = tidyPaths(home)
  if (!fs.existsSync(state)) return { lastRunAt: '', blocks: {} }
  try { return { lastRunAt: '', blocks: {}, ...JSON.parse(fs.readFileSync(state, 'utf8')) } } catch { return { lastRunAt: '', blocks: {} } }
}

export function saveTidyState(home, state) {
  const p = tidyPaths(home)
  fs.mkdirSync(p.dir, { recursive: true })
  fs.writeFileSync(p.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** 抽取式摘要：去掉代码块/标题/链接语法，取第一句；太短就再带一句。 */
export function extractSummary(body, { max = 120 } = {}) {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')   // 标题整行丢掉：它通常就是块标题，不该进摘要
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  const sentences = text.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [text]
  let out = sentences[0].trim()
  if (out.length < 24 && sentences[1]) out = `${out}${sentences[1].trim()}`
  return out.length <= max ? out : `${out.slice(0, max)}…`
}

function tokensOf(row) {
  const text = `${row.title} ${String(row.body_plain ?? '').slice(0, INDEX_CHARS)}`
  return new Set(indexTokens(text).split(' ').filter((t) => t.length >= 2))
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** 把成对的"疑似重复"并成组：一组十四份副本，只报一次，不报 C(14,2) 对。 */
function groupDuplicates(pairs) {
  const adjacency = new Map()
  const scoreOf = new Map()
  for (const pair of pairs) {
    if (!adjacency.has(pair.a)) adjacency.set(pair.a, [])
    if (!adjacency.has(pair.b)) adjacency.set(pair.b, [])
    adjacency.get(pair.a).push(pair.b)
    adjacency.get(pair.b).push(pair.a)
    scoreOf.set(`${pair.a}|${pair.b}`, pair.score)
    scoreOf.set(`${pair.b}|${pair.a}`, pair.score)
  }
  const seen = new Set()
  const groups = []
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue
    const stack = [start]
    const ids = []
    let score = 0
    seen.add(start)
    while (stack.length) {
      const node = stack.pop()
      ids.push(node)
      for (const next of adjacency.get(node) ?? []) {
        score = Math.max(score, scoreOf.get(`${node}|${next}`) ?? 0)
        if (!seen.has(next)) { seen.add(next); stack.push(next) }
      }
    }
    if (ids.length > 1) groups.push({ ids: ids.sort(), size: ids.length, score })
  }
  return groups.sort((a, b) => b.size - a.size)
}

/**
 * 扫一遍库：变更、缺摘要、疑似重复、候选关联。
 * 为了不让 1 万条时的两两比较爆炸，先建 token 倒排，只比较"共享词多"的候选对。
 */
export function scanTidy(db, home, { state = loadTidyState(home), dupThreshold = 0.6, linkThreshold = 0.2 } = {}) {
  const rows = db.prepare(`SELECT id, type, title, summary, body_plain, content_hash, domain, path
    FROM blocks WHERE deleted_at IS NULL`).all()
  const changed = rows.filter((row) => state.blocks[row.id] !== row.content_hash)
  const changedIds = new Set(changed.map((row) => row.id))

  const tokenSets = new Map()
  const inverted = new Map()
  for (const row of rows) {
    const tokens = tokensOf(row)
    tokenSets.set(row.id, tokens)
    for (const token of tokens) {
      if (!inverted.has(token)) inverted.set(token, [])
      inverted.get(token).push(row.id)
    }
  }

  const duplicates = []
  const links = []
  const seenPairs = new Set()
  for (const row of changed) {
    if (row.type !== 'knowledge') continue
    const shared = new Map()
    for (const token of tokenSets.get(row.id)) {
      for (const otherId of inverted.get(token) ?? []) {
        if (otherId === row.id) continue
        shared.set(otherId, (shared.get(otherId) ?? 0) + 1)
      }
    }
    const candidates = [...shared.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    for (const [otherId, sharedCount] of candidates) {
      if (sharedCount < 2) continue
      const pair = [row.id, otherId].sort().join('|')
      if (seenPairs.has(pair)) continue
      seenPairs.add(pair)
      const score = jaccard(tokenSets.get(row.id), tokenSets.get(otherId))
      if (score >= dupThreshold) duplicates.push({ a: row.id, b: otherId, score: Number(score.toFixed(2)) })
      else if (score >= linkThreshold) links.push({ a: row.id, b: otherId, score: Number(score.toFixed(2)) })
    }
  }

  const missingSummary = changed.filter((row) => !String(row.summary ?? '').trim())
  const duplicatePairs = duplicates.length
  const duplicateGroups = groupDuplicates(duplicates)
  const tasks = []
  for (const row of missingSummary) {
    tasks.push({ type: 'summary', id: row.id, title: row.title, snippet: String(row.body_plain ?? '').slice(0, 300) })
  }
  for (const group of duplicateGroups) {
    tasks.push({ type: 'duplicate_group', ids: group.ids, size: group.size, score: group.score })
  }
  for (const link of links.slice(0, 20)) {
    tasks.push({ type: 'link_check', a: link.a, b: link.b, score: link.score })
  }

  return {
    scannedAt: new Date().toISOString(),
    totals: {
      blocks: rows.length,
      changed: changed.length,
      missingSummary: missingSummary.length,
      duplicates: duplicateGroups.length,
      duplicatePairs,
      links: links.length,
      tasks: tasks.length,
    },
    changed: changed.map((row) => ({ id: row.id, title: row.title, type: row.type, domain: row.domain })),
    missingSummary: missingSummary.map((row) => ({ id: row.id, title: row.title })),
    duplicates: duplicateGroups,
    links,
    tasks,
  }
}

/** 只补"简介为空"的块；已有简介一个字都不动。返回改了哪些。 */
export function applySummaries(db, home, report) {
  const applied = []
  for (const item of report.missingSummary) {
    const row = db.prepare('SELECT id, path FROM blocks WHERE id = ?').get(item.id)
    if (!row) continue
    const meta = readBlockFile(row.path)
    if (String(meta.summary ?? '').trim()) continue
    const summary = extractSummary(meta.body)
    if (!summary) continue
    meta.summary = summary
    meta.modified_at = new Date().toISOString()
    meta.version = Number(meta.version ?? 1) + 1
    meta.editor = 'algorithm'
    const abs = writeBlockFile(home, meta)
    upsertBlock(db, { ...meta, path: abs })
    applied.push(item.id)
  }
  return applied
}

/** 跑一次整理：默认只报告，不改库。 */
export function tidy(db, home, { apply = false, state = loadTidyState(home) } = {}) {
  const report = scanTidy(db, home, { state })
  report.applied = apply ? applySummaries(db, home, report) : []
  const p = tidyPaths(home)
  fs.mkdirSync(p.dir, { recursive: true })
  fs.writeFileSync(p.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(p.tasks, `${JSON.stringify(report.tasks, null, 2)}\n`, 'utf8')

  // 标记已看过的内容哈希；下次只报新变更
  const blocks = { ...state.blocks }
  for (const row of db.prepare('SELECT id, content_hash FROM blocks WHERE deleted_at IS NULL').all()) {
    blocks[row.id] = row.content_hash
  }
  saveTidyState(home, { lastRunAt: report.scannedAt, blocks })
  report.paths = p
  return report
}
