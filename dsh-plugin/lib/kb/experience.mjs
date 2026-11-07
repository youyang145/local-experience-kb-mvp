/**
 * 经验块（KB5 + 手稿 ⑥）。
 *
 * 定位：不是"操作记录"，是知识库用着用着长出来的新判断。
 * 五个动作：套用 apply / 自创 insight / 融合 merge / 推翻 refute / 跨域派生 transplant。
 * 账：used / succeeded / occurrences / refined / human_vote / pinned。
 *
 * 归属：经验按"出生领域"存放（D-025）；融合经验的出生地 = 解决的那个问题所在领域（D-026）。
 */
import { newId, contentHash } from './ids.mjs'
import { clip } from './text.mjs'
import { readBlockFile, writeBlockFile } from './blocks.mjs'
import { getBlock, upsertBlock } from './db.mjs'
import { withLock } from './lock.mjs'

export const KINDS = ['insight', 'fusion', 'transfer']
export const TIERS = ['probation', 'main']
export const STATUS = ['candidate', 'verified', 'refuted']

function nowIso() {
  return new Date().toISOString()
}

function defaultAccounting() {
  return {
    used: 0,
    succeeded: 0,
    occurrences: 0,
    refined: 0,
    human_vote: 0,
    pinned: false,
    last_seen_at: '',
    last_used_at: '',
  }
}

function defaultLineage() {
  return { fused_from: [], derived_from: [], superseded_by: '', refuted_by: [] }
}

/** 从块头还原一条经验的规范形态（保留未知字段，避免升级时丢账）。 */
export function normalizeExp(meta) {
  const acc = meta.accounting ?? {}
  const lin = meta.lineage ?? {}
  return {
    ...meta,
    kind: KINDS.includes(meta.kind) ? meta.kind : 'insight',
    tier: TIERS.includes(meta.tier) ? meta.tier : 'main',
    claim: meta.claim ?? meta.title ?? '',
    scope: meta.scope ?? '',
    limits: meta.limits ?? '',
    status: STATUS.includes(meta.status) ? meta.status : 'candidate',
    orphaned: Boolean(meta.orphaned),
    primary_knowledge: meta.primary_knowledge ?? '',
    lineage: {
      ...defaultLineage(),
      ...lin,
      fused_from: Array.isArray(lin.fused_from) ? lin.fused_from : [],
      derived_from: Array.isArray(lin.derived_from) ? lin.derived_from : [],
      refuted_by: Array.isArray(lin.refuted_by) ? lin.refuted_by : [],
    },
    accounting: {
      ...defaultAccounting(),
      ...acc,
      used: Number(acc.used ?? 0),
      succeeded: Number(acc.succeeded ?? 0),
      occurrences: Number(acc.occurrences ?? 0),
      refined: Number(acc.refined ?? 0),
      human_vote: Number(acc.human_vote ?? 0),
      pinned: Boolean(acc.pinned),
    },
  }
}

/**
 * 优先级。作者定：复现比成功重（D-007）。
 *   4√复现 + 3成功 + 2使用 + 2补充 + 5人票 + 置顶1000 − 闲置衰减
 * 闲置从"最后一次出现或使用"起算，30 天后每天 −0.5。
 */
export function priority(exp, now = new Date()) {
  const acc = exp.accounting
  let score = 4 * Math.sqrt(Math.max(0, acc.occurrences))
    + 3 * acc.succeeded
    + 2 * acc.used
    + 2 * acc.refined
    + 5 * acc.human_vote
  if (acc.pinned) score += 1000
  const lastRaw = acc.last_seen_at || acc.last_used_at || exp.modified_at || exp.created_at
  const last = Date.parse(lastRaw)
  if (Number.isFinite(last)) {
    const idleDays = (now.getTime() - last) / 86400000
    if (idleDays > 30) score -= (idleDays - 30) * 0.5
  }
  return Math.max(0, Number(score.toFixed(2)))
}

/** 把优先级拆成可读的"为什么排前面"。 */
export function explain(exp) {
  const acc = exp.accounting
  const parts = []
  if (acc.occurrences) parts.push(`复现 ${acc.occurrences} 次`)
  if (acc.succeeded) parts.push(`成功 ${acc.succeeded} 次`)
  if (acc.used) parts.push(`用过 ${acc.used} 次`)
  if (acc.refined) parts.push(`补充 ${acc.refined} 次`)
  if (acc.human_vote) parts.push(`人票 ${acc.human_vote > 0 ? '+' : ''}${acc.human_vote}`)
  if (acc.pinned) parts.push('已置顶')
  if (exp.orphaned) parts.push('孤儿（来源知识块已删）')
  return parts.length ? parts.join(' ｜ ') : '还没有任何记录'
}

/** 造一条经验块（不落盘）。 */
export function makeExperience(input, { at = new Date(), salt } = {}) {
  const claim = String(input.claim ?? '').trim()
  if (!claim) throw new Error('经验块必须有 claim（一句话判断）')
  const kind = KINDS.includes(input.kind) ? input.kind : 'insight'
  const domain = String(input.domain ?? input.area ?? 'default').trim() || 'default'
  const tier = TIERS.includes(input.tier) ? input.tier : 'main'
  const status = STATUS.includes(input.status) ? input.status : 'candidate'
  const created_at = at.toISOString()
  return {
    id: newId({ at, title: claim, salt }),
    type: 'experience',
    kind,
    title: clip(claim, 60),
    claim,
    summary: clip(input.scope ?? claim, 160),
    scope: String(input.scope ?? '').trim(),
    limits: String(input.limits ?? '').trim(),
    body: String(input.body ?? '').trim() || `判断：${claim}`,
    source: String(input.source ?? '').trim(),
    domain,
    primary_knowledge: String(input.primary_knowledge ?? '').trim(),
    orphaned: false,
    tier,
    status,
    created_at,
    modified_at: created_at,
    version: 1,
    editor: input.editor ?? 'local',
    content_hash: contentHash(claim),
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    lineage: { ...defaultLineage(), ...(input.lineage ?? {}) },
    accounting: { ...defaultAccounting(), ...(input.accounting ?? {}) },
  }
}

// ---------- 读写 ----------

export function experienceOf(db, home, id) {
  const row = getBlock(db, id)
  if (!row) throw new Error(`块不存在：${id}`)
  if (row.type !== 'experience') throw new Error(`${id} 不是经验块（type=${row.type}）`)
  const meta = readBlockFile(row.path)
  return { row, exp: normalizeExp(meta), abs: row.path }
}

function persist(db, home, exp) {
  const next = { ...exp, modified_at: nowIso() }
  const abs = writeBlockFile(home, next)
  upsertBlock(db, { ...next, path: abs })
  return next
}

/** 读-改-写放进同一把锁：界面和命令行同时点，不会丢一次计数。 */
function mutate(db, home, id, fn) {
  return withLock(home, `exp-${id}`, () => {
    const { exp } = experienceOf(db, home, id)
    const result = fn(exp) ?? exp
    return persist(db, home, result)
  })
}

// ---------- 五个动作 ----------

/** 套用：used+1；成功再 succeeded+1。 */
export function applyUse(db, home, id, { result = 'unknown', method = 'self', note = '' } = {}) {
  if (!['success', 'failure', 'unknown'].includes(result)) throw new Error(`未知结果：${result}`)
  if (!['self', 'human', 'signal'].includes(method)) throw new Error(`未知记账通道：${method}`)
  return mutate(db, home, id, (exp) => {
    exp.accounting.used += 1
    if (result === 'success') exp.accounting.succeeded += 1
    exp.accounting.last_used_at = nowIso()
    exp.accounting.last_result = result
    exp.accounting.last_method = method
    if (note) exp.accounting.last_note = note
    if (method === 'human') exp.editor = 'human'
  })
}

/** 复现：同一个问题又出现了。不改 used，只说明这个场景又来了。 */
export function recordOccurrence(db, home, id, { note = '' } = {}) {
  return mutate(db, home, id, (exp) => {
    exp.accounting.occurrences += 1
    exp.accounting.last_seen_at = nowIso()
    if (note) exp.accounting.last_note = note
  })
}

/** 补充：这条经验被补了一次（新条件、新证据、新边界）。 */
export function refine(db, home, id, { note = '' } = {}) {
  return mutate(db, home, id, (exp) => {
    exp.accounting.refined += 1
    exp.version = (exp.version ?? 1) + 1
    if (note) exp.body = `${exp.body.trim()}\n\n补充（${nowIso().slice(0, 10)}）：${note}`
  })
}

/** 融合：吃两条（知识或经验），产出新经验；旧经验标 superseded_by。 */
export function merge(db, home, aId, bId, { claim, scope = '', domain, at = new Date() } = {}) {
  const a = getBlock(db, aId)
  const b = getBlock(db, bId)
  if (!a || !b) throw new Error('融合的两个来源必须都存在')
  if (aId === bId) throw new Error('不能和自己融合')
  // 出生地：融合经验的家 = 解决的那个问题所在的领域（D-026）；没给就跟随 a 的领域。
  const born = domain || a.domain || 'default'
  const exp = makeExperience({
    claim,
    kind: 'fusion',
    scope,
    domain: born,
    lineage: { fused_from: [aId, bId] },
    body: `判断：${claim}\n\n来源：${a.title}（${aId}） + ${b.title}（${bId}）`,
    evidence: [aId, bId],
  }, { at })
  exp.tier = 'probation'
  persist(db, home, exp)

  for (const src of [a, b]) {
    if (src.type !== 'experience') continue
    withLock(home, `exp-${src.id}`, () => {
      const old = normalizeExp(readBlockFile(src.path))
      old.lineage.superseded_by = exp.id
      persist(db, home, old)
    })
  }
  return exp
}

/** 跨域派生：父经验不动，在目标领域长出一条专属的。 */
export function transplant(db, home, id, { domain, claim, scope = '', at = new Date() } = {}) {
  if (!domain) throw new Error('跨域派生需要 --domain（目标领域）')
  const { exp: parent } = experienceOf(db, home, id)
  const exp = makeExperience({
    claim: claim || parent.claim,
    kind: 'transfer',
    scope: scope || `领域：${domain}`,
    domain,
    lineage: { derived_from: [id] },
    body: `从「${parent.claim}」（${id}，${parent.domain}）迁移过来，在 ${domain} 里验证有效。`,
    evidence: [id],
  }, { at })
  exp.tier = 'probation'
  return persist(db, home, exp)
}

/** 推翻：留反例，不删。 */
export function refute(db, home, id, { by = '', note = '' } = {}) {
  return mutate(db, home, id, (exp) => {
    exp.status = 'refuted'
    exp.lineage.refuted_by = [...(exp.lineage.refuted_by ?? []), by].filter(Boolean)
    if (note) exp.body = `${exp.body.trim()}\n\n反例（${nowIso().slice(0, 10)}）：${note}`
  })
}

/** 人票：+1 / -1，累加到 human_vote。 */
export function vote(db, home, id, value) {
  if (![1, -1].includes(value)) throw new Error('人工票只能是 +1 或 -1')
  return mutate(db, home, id, (exp) => {
    exp.accounting.human_vote += value
    if (exp.accounting.human_vote > 0 && exp.status === 'candidate') exp.status = 'verified'
  })
}

export function pin(db, home, id, on = true) {
  return mutate(db, home, id, (exp) => {
    exp.accounting.pinned = Boolean(on)
  })
}

/** 转正：小经验区 → 主库；同时记下"谁、什么时候验证的"（D-030 补留痕）。 */
export function promote(db, home, id) {
  return mutate(db, home, id, (exp) => {
    exp.tier = 'main'
    exp.status = 'verified'
    exp.editor = 'human'
    exp.verified_by = 'human'
    exp.verified_at = nowIso()
    exp.verify_scope = 'full'
  })
}

/** 列出经验（默认按优先级从高到低）。 */
export function listExperiences(db, home, { includeRefuted = false, domain, limit = 50 } = {}) {
  const rows = db.prepare(`SELECT id, path FROM blocks
    WHERE type='experience' AND deleted_at IS NULL ${domain ? 'AND domain = ?' : ''}`)
    .all(...(domain ? [domain] : []))
  const out = []
  for (const row of rows) {
    const exp = normalizeExp(readBlockFile(row.path))
    if (!includeRefuted && exp.status === 'refuted') continue
    out.push({ ...exp, priority: priority(exp) })
  }
  out.sort((a, b) => b.priority - a.priority)
  return out.slice(0, limit)
}

export function scoreText(exp) {
  const acc = exp.accounting
  if (!acc.used) return '还没用过'
  return `${acc.succeeded}/${acc.used} = ${((acc.succeeded / acc.used) * 100).toFixed(0)}%`
}

/**
 * 知识块被删时，把挂在它下面的经验标成孤儿（D-027）。
 * 不删经验、不挪目录——孤儿留在原领域里，等重挂。
 */
export function orphanExperiences(db, home, knowledgeId) {
  const rows = db.prepare(`SELECT id, path FROM blocks
    WHERE type='experience' AND primary_knowledge = ? AND deleted_at IS NULL`).all(knowledgeId)
  const out = []
  for (const row of rows) {
    withLock(home, `exp-${row.id}`, () => {
      const exp = normalizeExp(readBlockFile(row.path))
      exp.orphaned = true
      exp.primary_knowledge = ''
      persist(db, home, exp)
    })
    out.push(row.id)
  }
  return out
}
