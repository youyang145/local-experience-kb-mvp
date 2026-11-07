/**
 * 资料入库：先分块 + 猜分区，人确认后再落盘（P2b 的算法半边）。
 *
 * 流程（不替人做决定）：
 *   1. 分块：按标题切；没标题按段落合并，单块上限 ~1200 字；
 *   2. 猜分区：拿块里的词去撞库里各分区的已有内容，给前 3 个候选与分数；
 *   3. 出计划：写到 `<home>/_ingest/<时间>.json`，不落盘；
 *   4. 人改计划（或直接给 --domain）后 `kb ingest --apply` 才入库。
 *
 * AI 那一半以后接插件：读计划、填 chosen、再 apply。
 */
import fs from 'node:fs'
import path from 'node:path'
import { layout } from './config.mjs'
import { buildCandidate } from './capture.mjs'
import { writeBlockFile } from './blocks.mjs'
import { upsertBlock } from './db.mjs'
import { segments } from './text.mjs'

/** 切成块：优先按 Markdown 标题，其次按空行段落。 */
export function chunkText(text, { max = 1200 } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) return []

  const byHeading = raw.split(/\n(?=#{1,3}\s)/).map((part) => part.trim()).filter(Boolean)
  if (byHeading.length > 1) {
    // 有标题就按标题切，不跨标题合并
    const out = []
    for (const piece of byHeading) {
      if (piece.length <= max * 1.5) { out.push(piece); continue }
      for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max))
    }
    return out
  }
  const pieces = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)

  const chunks = []
  let buffer = ''
  for (const piece of pieces) {
    if (buffer && (buffer + '\n\n' + piece).length > max) {
      chunks.push(buffer)
      buffer = piece
    } else {
      buffer = buffer ? `${buffer}\n\n${piece}` : piece
    }
  }
  if (buffer) chunks.push(buffer)

  // 超长单块再硬切
  const out = []
  for (const chunk of chunks) {
    if (chunk.length <= max * 1.5) { out.push(chunk); continue }
    for (let i = 0; i < chunk.length; i += max) out.push(chunk.slice(i, i + max))
  }
  return out
}

function chunkTitle(chunk, index, fallback, total) {
  // 单块投稿时尊重调用方传的标题；正文标题只作兜底
  if (total === 1 && fallback) return fallback.trim().slice(0, 80)
  const heading = chunk.match(/^#{1,3}\s+(.+)$/m)
  if (heading) return heading[1].trim().slice(0, 80)
  const firstLine = (chunk.split('\n').find((l) => l.trim()) ?? '').replace(/^[#>*\-\s]+/, '').trim()
  // 第一行够短才拿来当标题；否则只留编号，避免标题被截成半句话
  if (firstLine && firstLine.length <= 30) return `${fallback}（${index + 1}）：${firstLine}`
  return `${fallback}（${index + 1}）`
}

/** 猜分区：块的词项与各分区已有内容的词项重合度。 */
export function suggestDomains(db, text, { top = 3 } = {}) {
  const terms = new Set()
  for (const seg of segments(text)) {
    if (seg.kind === 'cjk') {
      if (seg.text.length === 1) terms.add(seg.text)
      else seg.bigrams.forEach((t) => terms.add(t))
    } else terms.add(seg.text.toLowerCase())
  }
  if (!terms.size) return []

  const domains = db.prepare(`SELECT domain, count(*) AS n FROM blocks
    WHERE deleted_at IS NULL GROUP BY domain`).all()
  const scores = []
  for (const { domain } of domains) {
    const rows = db.prepare(`SELECT title, summary FROM blocks
      WHERE deleted_at IS NULL AND (domain = ? OR domain LIKE ? || '/%') LIMIT 30`).all(domain, domain)
    const hay = rows.map((r) => `${r.title} ${r.summary}`).join(' ').toLowerCase()
    if (!hay) continue
    let hit = 0
    for (const term of terms) if (hay.includes(term)) hit += 1
    const score = hit / terms.size
    if (score > 0) scores.push({ domain, score: Number(score.toFixed(3)) })
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, top)
}

/** 出计划：分块 + 每块的候选分区，不写库。 */
export function planIngest(db, { title, text }) {
  const bodies = chunkText(text)
  const total = bodies.length
  const chunks = bodies.map((body, index) => ({
    index,
    title: chunkTitle(body, index, title, total),
    body,
    suggestions: suggestDomains(db, body),
    chosen: '',
  }))
  return { title, created_at: new Date().toISOString(), chunks }
}

export function writePlan(home, plan) {
  const dir = path.join(home, '_ingest')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `plan-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8')
  return file
}

/**
 * 落盘：按计划逐块建知识块。
 * 分区优先级：chunk.chosen > 调用方给的 domain > 候选最高分（≥0.15）> 待分区。
 */
export function applyPlan(db, home, plan, { domain = '' } = {}) {
  const created = []
  for (const chunk of plan.chunks) {
    const best = chunk.suggestions?.[0]
    const chosen = chunk.chosen || domain || (best && best.score >= 0.15 ? best.domain : '待分区')
    const block = buildCandidate({
      title: chunk.title,
      body: chunk.body,
      domain: chosen,
      source: plan.title ? `ingest:${plan.title}` : 'ingest',
      summary: chunk.body.replace(/\s+/g, ' ').slice(0, 120),
    })
    const abs = writeBlockFile(home, block)
    upsertBlock(db, { ...block, path: abs })
    created.push({ id: block.id, title: block.title, domain: chosen })
  }
  return created
}
