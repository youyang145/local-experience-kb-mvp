/**
 * 文件级互助补全（deep scan）。
 *
 * 只在索引覆盖不到时使用：四方向共享"已处理"集合，先到先收录，
 * 后来者按 path/hash 去重后继续补自己的区域；带预算与完整性标记。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { segments } from './text.mjs'

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml'])
const SKIP_DIRS = new Set(['_trash', '_backup', '_ingest', '_mcp', 'node_modules'])
const MAX_BYTES = 512 * 1024

function walk(dir, base, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(abs, base, out)
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
      try {
        const stat = fs.statSync(abs)
        if (stat.size <= MAX_BYTES) out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/'), size: stat.size })
      } catch { /* ignore */ }
    }
  }
  return out
}

function tokensOf(query) {
  const tokens = new Set()
  for (const seg of segments(query)) {
    if (seg.kind === 'cjk') {
      if (seg.text.length === 1) tokens.add(seg.text)
      else seg.bigrams.forEach((t) => tokens.add(t))
    } else {
      tokens.add(seg.text.toLowerCase())
    }
  }
  return [...tokens].filter(Boolean)
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line)
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return meta
}

export function deepScan(home, query, {
  limit = 8,
  budgetMs = 300,
  concurrency = 4,
  complete = false,
  channels = ['forward', 'reverse', 'middle', 'random'],
} = {}) {
  const tokens = tokensOf(query)
  if (!tokens.length) return { hits: [], complete: true, coverage: 1, filesRead: 0, bytes: 0, elapsedMs: 0 }

  const files = walk(path.join(home, 'blocks'), path.join(home, 'blocks')).sort((a, b) => a.rel.localeCompare(b.rel))
  if (!files.length) return { hits: [], complete: true, coverage: 1, filesRead: 0, bytes: 0, elapsedMs: 0 }

  const n = files.length
  const orders = {
    forward: Array.from({ length: n }, (_, i) => i),
    reverse: Array.from({ length: n }, (_, i) => n - 1 - i),
    middle: (() => {
      const out = []
      let left = Math.floor(n / 2)
      let right = left + 1
      out.push(left)
      while (out.length < n) {
        if (right < n) out.push(right++)
        if (left - 1 >= 0) out.push(--left)
      }
      return out
    })(),
    random: (() => {
      const out = Array.from({ length: n }, (_, i) => i)
      let seed = 1
      for (const ch of query) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647
      const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
      for (let i = n - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    })(),
  }

  const cursors = channels.filter((name) => orders[name]).map((name) => ({ name, order: orders[name], ptr: 0 }))
  if (!cursors.length) cursors.push({ name: 'forward', order: orders.forward, ptr: 0 })

  const done = new Set()
  const seenHashes = new Set()
  const hits = []
  let turn = 0
  let filesRead = 0
  let bytes = 0
  let skipped = 0
  const start = performance.now()

  function next() {
    for (let tries = 0; tries < cursors.length; tries += 1) {
      const cursor = cursors[turn % cursors.length]
      turn += 1
      while (cursor.ptr < cursor.order.length && done.has(cursor.order[cursor.ptr])) cursor.ptr += 1
      if (cursor.ptr < cursor.order.length) return cursor.order[cursor.ptr++]
    }
    return null
  }

  async function worker() {
    while (done.size < n) {
      if (!complete && hits.length >= limit) return
      if (performance.now() - start > budgetMs) return
      const index = next()
      if (index === null) return
      if (done.has(index)) { skipped += 1; continue }
      const file = files[index]
      let text
      try { text = await fsp.readFile(file.abs, 'utf8') } catch { done.add(index); continue }
      done.add(index)
      filesRead += 1
      bytes += file.size
      const hay = text.toLowerCase()
      let matched = 0
      for (const token of tokens) if (hay.includes(token)) matched += 1
      if (!matched) continue
      const hash = crypto.createHash('sha1').update(text).digest('hex')
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)
      const meta = frontmatter(text)
      hits.push({
        id: meta.id ?? file.rel,
        title: meta.title ?? file.rel,
        summary: meta.summary ?? '',
        domain: meta.domain ?? '',
        type: meta.type ?? 'knowledge',
        path: file.rel,
        score: matched / tokens.length,
        source: 'deep',
      })
    }
  }

  // 这里用同步读，靠 worker 数模拟并发；Node 单线程下主要收益来自隐藏 I/O 等待。
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker())
  return Promise.all(workers).then(() => {
    const coverage = n ? done.size / n : 1
    return {
      hits: hits.sort((a, b) => b.score - a.score).slice(0, Math.max(limit, complete ? hits.length : limit)),
      complete: done.size >= n,
      coverage,
      filesRead,
      bytes,
      elapsedMs: performance.now() - start,
      skipped,
      strategies: cursors.map((c) => c.name),
    }
  })
}

