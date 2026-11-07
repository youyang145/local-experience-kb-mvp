/**
 * 检索警示（反例通道）。
 *
 * 手稿 02 的规则是"反例不参与推荐，但检索时可选显示"。
 * 2026-11-01 定死触发时机（D-031）：**不在每次搜索时弹**，只在两种时刻亮——
 *   1. 准备套用某条经验时（提示"这条有反例"）；
 *   2. 当前查询与该反例高度相似时（词项重合达到阈值，且查询至少两个词项）。
 * 警示不占正文召回名额，不改变主结果排序。
 */
import { readBlockFile } from './blocks.mjs'
import { getBlock, searchBlocks } from './db.mjs'
import { segments } from './text.mjs'

/** 把查询切成词项：汉字取二元组（单字直通），拉丁取整词。 */
export function queryTerms(query) {
  const terms = []
  for (const seg of segments(query)) {
    if (seg.kind === 'cjk') {
      if (seg.text.length === 1) terms.push(seg.text)
      else terms.push(...seg.bigrams)
    } else {
      terms.push(seg.text)
    }
  }
  return [...new Set(terms)]
}

function refutedRows(db) {
  return db.prepare(`SELECT id, path, domain FROM blocks
    WHERE type='experience' AND status='refuted' AND deleted_at IS NULL`).all()
}

function describe(row, meta) {
  return {
    id: row.id,
    claim: meta.claim ?? meta.title ?? '',
    domain: meta.domain ?? '',
    scope: meta.scope ?? '',
    limits: meta.limits ?? '',
    refuted_by: meta.lineage?.refuted_by ?? [],
  }
}

/**
 * 查询侧的警示：只有"高度相似"才返回。
 * 单个词项的查询一律不弹——否则搜"分词"就弹一条反例，用三天就想关掉。
 */
export function findWarnings(db, query, { limit = 3, minTerms = 2, minOverlap = 0.5 } = {}) {
  const terms = queryTerms(query)
  if (terms.length < minTerms) return []

  const hits = []
  for (const row of refutedRows(db)) {
    const meta = readBlockFile(row.path)
    const hay = [meta.claim, meta.title, meta.scope, meta.limits, meta.body]
      .filter(Boolean).join(' ').toLowerCase()
    const overlap = terms.filter((term) => hay.includes(term)).length / terms.length
    if (overlap < minOverlap) continue
    hits.push({ ...describe(row, meta), overlap })
  }
  hits.sort((a, b) => b.overlap - a.overlap)
  return hits.slice(0, limit).map(({ overlap, ...rest }) => rest)
}

/**
 * 套用前的警示：拿这条经验自己的判断与范围去撞反例。
 * 同领域共享一个词项即提醒；跨领域要共享两个以上。
 */
export function warningsForApply(db, id, { limit = 3 } = {}) {
  const row = getBlock(db, id)
  if (!row) return []
  const meta = readBlockFile(row.path)
  const terms = queryTerms(`${meta.claim ?? meta.title ?? ''} ${meta.scope ?? ''}`)
  if (!terms.length) return []

  const hits = []
  for (const ref of refutedRows(db)) {
    if (ref.id === id) continue
    const refMeta = readBlockFile(ref.path)
    const hay = [refMeta.claim, refMeta.title, refMeta.scope, refMeta.limits, refMeta.body]
      .filter(Boolean).join(' ').toLowerCase()
    const shared = terms.filter((term) => hay.includes(term)).length
    const sameDomain = refMeta.domain && refMeta.domain === meta.domain
    if (shared < (sameDomain ? 1 : 2)) continue
    hits.push({ ...describe(ref, refMeta), shared })
  }
  hits.sort((a, b) => b.shared - a.shared)
  return hits.slice(0, limit).map(({ shared, ...rest }) => rest)
}

/** 检索 + 警示：主结果保持原样，警示单独一段（默认大多为空）。 */
export function searchWithWarnings(db, query, { limit = 10, includeRefuted = false } = {}) {
  const rows = searchBlocks(db, query, { limit, includeRefuted })
  return { rows, warnings: includeRefuted ? [] : findWarnings(db, query) }
}
