/**
 * 查库判定（D-035 的实现内核）。
 *
 * 插件外壳以后只要调这里：先问"这轮要不要查库"，再拿索引摘要与命中。
 * 现在 CLI 和面板也能用，但不主动——主动性留给宿主。
 */
import { searchBlocks, getBlock, fallbackLike, counts } from './db.mjs'
import { searchWithWarnings } from './warnings.mjs'
import { segments } from './text.mjs'

const SMALL_TALK = /^(你好|您好|hi|hello|嗨|在吗|谢谢|多谢|谢了|早|早安|晚安|好的|ok|嗯|哈哈)[!！。.~～\s]*$/i
const CHAT_PREFIX = /^(今天天气|天气|吃了吗|吃饭了吗|在干嘛|干嘛呢|无聊|好累|累了|心情|周末|早安|早上好|中午好|晚上好)/

/** 这轮要不要查库：闲聊、空查询、纯符号一律跳过。 */
export function shouldConsult(query) {
  const q = String(query ?? '').trim()
  if (!q) return { yes: false, reason: '空查询' }
  if (SMALL_TALK.test(q)) return { yes: false, reason: '闲聊，不需要查库' }
  if (q.replace(/[\s\p{P}]/gu, '').length < 2) return { yes: false, reason: '太短，信息量不足' }
  if (CHAT_PREFIX.test(q) && q.replace(/\s/g, '').length <= 12) return { yes: false, reason: '闲聊，不需要查库' }
  return { yes: true, reason: '有信息需求' }
}

/** 索引摘要：总量 + 分区（知识/经验分列）+ 每区几条标题，给 AI 当"目录"。 */
export function indexSummary(db, { topDomains = 8, titlesPerDomain = 2 } = {}) {
  const totals = counts(db)
  const head = `库：${totals.blocks} 块（知识 ${totals.knowledge} / 经验 ${totals.experience}）｜小经验区 ${totals.probation}｜反例 ${totals.refuted}`

  const domains = db.prepare(`SELECT domain, count(*) AS n FROM blocks
    WHERE deleted_at IS NULL GROUP BY domain ORDER BY n DESC LIMIT ?`).all(topDomains)
  if (!domains.length) return { text: `${head}\n（还没有分区内容）`, domains: [], totals }

  const list = domains.map((d) => {
    const byType = db.prepare(`SELECT type, count(*) AS n FROM blocks
      WHERE deleted_at IS NULL AND (domain = ? OR domain LIKE ? || '/%') GROUP BY type`)
      .all(d.domain, d.domain)
    const knowledge = byType.find((row) => row.type === 'knowledge')?.n ?? 0
    const experience = byType.find((row) => row.type === 'experience')?.n ?? 0
    const rows = db.prepare(`SELECT title, type FROM blocks
      WHERE deleted_at IS NULL AND (domain = ? OR domain LIKE ? || '/%')
      ORDER BY created_at DESC LIMIT ?`).all(d.domain, d.domain, titlesPerDomain)
    const label = d.domain === '待分区' ? '待分区·收件箱' : d.domain
    const types = [knowledge ? `知识 ${knowledge}` : '', experience ? `经验 ${experience}` : ''].filter(Boolean).join(' / ')
    const titles = rows.map((row) => `${row.type === 'experience' ? '经验·' : ''}${row.title}`).join('、')
    return {
      domain: d.domain,
      count: d.n,
      knowledge,
      experience,
      titles: rows.map((row) => row.title),
      line: `${label}（${d.n}${types ? '｜' + types : ''}）：${titles || '—'}`,
    }
  })

  const hidden = db.prepare(`SELECT count(*) AS n FROM (
    SELECT domain FROM blocks WHERE deleted_at IS NULL GROUP BY domain)`).get().n - list.length
  const lines = [head, ...list.map((d) => d.line)]
  if (hidden > 0) lines.push(`…还有 ${hidden} 个分区未列出，需要时调 kb_index 看全部`)
  return { text: lines.join('\n'), domains: list, totals }
}
/**
 * 软化检索：整句查不到时，拆成词逐个 LIKE，合并去重。
 * 例子：「GG 修改器 搜索不到数值怎么办」整句 FTS 不命中，但 "GG"「修改器」能命中。
 */
export function softSearch(db, query, limit) {
  const tokens = []
  for (const seg of segments(query)) {
    if (seg.kind === 'cjk') tokens.push(...seg.bigrams)
    else tokens.push(seg.text)
  }
  const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length)
  const merged = new Map()
  for (const token of unique) {
    for (const row of fallbackLike(db, token, limit)) {
      if (!merged.has(row.id)) merged.set(row.id, row)
    }
    if (merged.size >= limit) break
  }
  return [...merged.values()].slice(0, limit)
}

/**
 * 零命中时的判断：库里到底有没有"看起来相关"的分区。
 * 用来区分"库里没这个话题"和"有话题但这次没搜到"，避免模型把查不到当成确认没有。
 */
function zeroHitHint(db, query) {
  const domains = db.prepare(`SELECT domain, count(*) AS n FROM blocks
    WHERE deleted_at IS NULL GROUP BY domain ORDER BY n DESC`).all()
  if (!domains.length) {
    return { text: '库里还是空的，先入库再查。', related: null, domains: [] }
  }
  const tokens = []
  for (const seg of segments(query)) {
    if (seg.kind === 'cjk') tokens.push(...seg.bigrams)
    else tokens.push(seg.text.toLowerCase())
  }
  const unique = [...new Set(tokens)].filter((t) => t.length >= 2)
  const hayFor = (domain) => {
    const rows = db.prepare(`SELECT title, summary FROM blocks
      WHERE deleted_at IS NULL AND (domain = ? OR domain LIKE ? || '/%') LIMIT 40`).all(domain, domain)
    return (domain + ' ' + rows.map((r) => `${r.title} ${r.summary ?? ''}`).join(' ')).toLowerCase()
  }
  let best = null
  for (const d of domains) {
    const hay = hayFor(d.domain)
    let hit = 0
    for (const t of unique) if (hay.includes(t)) hit += 1
    const score = unique.length ? hit / unique.length : 0
    if (!best || score > best.score) best = { domain: d.domain, score }
  }
  const names = domains.map((d) => d.domain)
  const tops = names.slice(0, 6).join('、')
  if (best && best.score >= 0.2) {
    return {
      text: `没有命中。最接近的分区是「${best.domain}」，可能只是换了措辞，换个关键词再查。`,
      related: best.domain,
      domains: names,
    }
  }
  return {
    text: `没有命中，而且本库没有覆盖这个话题（现有分区：${tops}）。可以用你自己的知识回答，但要说明不是来自本库。`,
    related: null,
    domains: names,
  }
}

/**
 * 不读正文，只回简介；要不要往下读由调用方决定（三级读取的第二级）。
 */
export function consult(db, query, { limit = 5, includeRefuted = false } = {}) {
  const decision = shouldConsult(query)
  if (!decision.yes) {
    return { consult: false, reason: decision.reason, summary: '', rows: [], warnings: [] }
  }
  const searched = searchWithWarnings(db, query, { limit, includeRefuted })
  let rows = searched.rows
  if (!rows.length) rows = softSearch(db, query, limit)
  const hits = rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    domain: row.domain,
    type: row.type,
    score: row.score,
  }))
  return {
    consult: true,
    reason: decision.reason,
    summary: indexSummary(db).text,
    rows: hits,
    warnings: searched.warnings,
    hasHits: hits.length > 0,
    zeroHit: hits.length ? null : zeroHitHint(db, query),
  }
}

/** 三级读取的第三级：按 id 取正文（调用方决定读几条）。 */
export function readBodies(db, ids, { max = 3 } = {}) {
  return ids.slice(0, max).map((id) => {
    const row = getBlock(db, id)
    return row ? { id: row.id, title: row.title, body: row.body_plain, domain: row.domain } : null
  }).filter(Boolean)
}




