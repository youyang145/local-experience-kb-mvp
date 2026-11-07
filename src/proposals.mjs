/**
 * 提议与拍板（M2）。
 *
 * 规则：记账不用问，长经验必须问。
 *   review 模式：AI 只能提名，人点头才落盘；
 *   auto 模式：直接进小经验区（probation），攒够分量再通知；
 *   off 模式：不生成。
 *
 * 例外：推翻（refute）永远走审核——废掉一条经验的风险太大，不能免审。
 */
import {
  loadSettings, checkReviewGate, noteProposal, noteAutoApplied, shouldNotify,
  loadState, saveState, localDay,
} from './settings.mjs'
import { makeExperience, merge, transplant, refute, promote, normalizeExp } from './experience.mjs'
import { writeBlockFile, readBlockFile } from './blocks.mjs'
import { upsertBlock } from './db.mjs'

export const ACTIONS = ['new', 'merge', 'transplant', 'refute', 'promote']

/**
 * 默认门槛（D-039）：只管"能不能提名"，**不拦提交**。
 * 不满足时在返回值里带 warnings，让人拍板时看到；宿主可收紧，放宽要留审计。
 */
function gateWarnings(db, action, payload) {
  const warnings = []
  if (action !== 'promote' && action !== 'refute') return warnings
  const row = db.prepare('SELECT * FROM blocks WHERE id = ?').get(payload.id)
  if (!row) return [`找不到目标：${payload.id}`]
  const exp = normalizeExp(readBlockFile(row.path))
  const acc = exp.accounting ?? {}
  if (action === 'promote') {
    if ((acc.succeeded ?? 0) < 2) warnings.push(`成功次数 ${acc.succeeded ?? 0} < 2（默认门槛）`)
    if ((acc.occurrences ?? 0) < 2) warnings.push(`复现次数 ${acc.occurrences ?? 0} < 2（默认门槛）`)
    if (!exp.scope || !exp.limits) warnings.push('scope/limits 没写全，说不清边界')
  } else if ((acc.occurrences ?? 0) < 2 && !payload.note) {
    warnings.push('只复现过一次，且没写反例说明')
  }
  return warnings
}

function insertProposal(db, { action, mode, status, payload, reason, proposedClaim }) {
  const info = db.prepare(`INSERT INTO proposals(action, mode, status, payload, reason, proposed_claim, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    action, mode, status, JSON.stringify(payload), reason ?? '', proposedClaim ?? '', new Date().toISOString(),
  )
  return Number(info.lastInsertRowid)
}

function buildExperience(db, home, action, payload) {
  if (action === 'new') {
    const exp = makeExperience({ ...payload, tier: 'probation', status: 'candidate' })
    const abs = writeBlockFile(home, exp)
    upsertBlock(db, { ...exp, path: abs })
    return exp
  }
  if (action === 'merge') {
    return merge(db, home, payload.a, payload.b, {
      claim: payload.claim,
      scope: payload.scope ?? '',
      domain: payload.domain,
    })
  }
  if (action === 'transplant') {
    return transplant(db, home, payload.id, {
      domain: payload.domain,
      claim: payload.claim,
      scope: payload.scope ?? '',
    })
  }
  if (action === 'refute') {
    return refute(db, home, payload.id, { by: payload.by ?? '', note: payload.note ?? '' })
  }
  if (action === 'promote') {
    return promote(db, home, payload.id)
  }
  throw new Error(`未知提议类型：${action}`)
}

/**
 * 提交一条提议。
 * @returns {{status:'off'|'skipped'|'pending'|'applied', seq?:number, id?:string, reason?:string, notify?:object}}
 */
export function submit(db, home, { action, payload, reason = '', proposedClaim = '' }) {
  const settings = loadSettings(home)
  const mode = settings.experience.mode
  if (mode === 'off') {
    return { status: 'off', reason: '经验生成已关闭；可用 kb settings set experience.mode review 打开' }
  }

  const warnings = gateWarnings(db, action, payload)

  // 推翻与转正永远要人审
  const effectiveMode = (action === 'refute' || action === 'promote') ? 'review' : mode

  if (effectiveMode === 'review') {
    const claimForGate = payload.claim ?? payload.id ?? ''
    const gate = checkReviewGate(home, settings, `${action}:${claimForGate}`)
    if (!gate.allowed) return { status: 'skipped', reason: gate.reason, warnings }
    const seq = insertProposal(db, { action, mode: 'review', status: 'pending', payload, reason, proposedClaim })
    noteProposal(home, gate.state, gate.key)
    return { status: 'pending', seq, warnings }
  }

  // 免审：直接进小经验区
  const state = loadState(home)
  const day = localDay()
  if (state.autoDay !== day) { state.autoDay = day; state.autoToday = 0 }
  const cap = Number(settings.experience.auto.maxPerDay)
  if ((state.autoToday ?? 0) >= cap) {
    return { status: 'skipped', reason: `小经验区今天已达上限（${cap} 条）` }
  }
  state.autoToday = (state.autoToday ?? 0) + 1
  saveState(home, state)

  const exp = buildExperience(db, home, action, payload)
  const seq = insertProposal(db, { action, mode: 'auto', status: 'auto_applied', payload, reason, proposedClaim })
  noteAutoApplied(home)
  return { status: 'applied', seq, id: exp.id, notify: shouldNotify(home, settings), warnings }
}

export function listProposals(db, { status = 'pending', limit = 20 } = {}) {
  return db.prepare(`SELECT * FROM proposals ${status ? 'WHERE status = ?' : ''} ORDER BY seq DESC LIMIT ?`)
    .all(...(status ? [status, limit] : [limit]))
}

export function getProposal(db, seq) {
  return db.prepare('SELECT * FROM proposals WHERE seq = ?').get(seq) ?? null
}

/** 拍板：要 → 落盘并转正；不要 → 留档。改过的以人改的为准。 */
export function decide(db, home, seq, { yes, note = '', claim } = {}) {
  const row = getProposal(db, seq)
  if (!row) throw new Error(`提议不存在：${seq}`)
  if (row.status !== 'pending') throw new Error(`提议 #${seq} 已经处理过了（${row.status}）`)

  if (!yes) {
    db.prepare("UPDATE proposals SET status='rejected', decided_at=?, decided_by='human', decision_note=? WHERE seq=?")
      .run(new Date().toISOString(), note, seq)
    return { status: 'rejected' }
  }

  const payload = JSON.parse(row.payload)
  if (claim) payload.claim = claim
  const warnings = gateWarnings(db, row.action, payload)
  const exp = buildExperience(db, home, row.action, payload)
  const final = row.action === 'refute' ? normalizeExp(exp) : row.action === 'promote' ? normalizeExp(exp) : promote(db, home, exp.id)
  db.prepare("UPDATE proposals SET status='accepted', decided_at=?, decided_by='human', decision_note=? WHERE seq=?")
    .run(new Date().toISOString(), note, seq)
  return { status: 'accepted', id: final.id, claim: final.claim, proposed_claim: row.proposed_claim || '', warnings }
}

/** 小经验区里还没转正的经验（按时间倒序）。 */
export function probationItems(db) {
  const rows = db.prepare(`SELECT id, path FROM blocks
    WHERE type='experience' AND tier='probation' AND status != 'refuted' AND deleted_at IS NULL
    ORDER BY created_at DESC`).all()
  return rows.map((row) => normalizeExp(readBlockFile(row.path)))
}

/** 提议卡：给终端看的一段人话。 */
export function card(row, index) {
  const payload = JSON.parse(row.payload)
  const actionName = { new: '新建经验', merge: '融合', transplant: '跨域派生', refute: '推翻', promote: '转正' }[row.action] ?? row.action
  const claim = payload.claim ?? payload.id ?? ''
  const lines = [
    `${index}. 提议${actionName}：${claim}`,
    `   依据 ${row.reason || '（未填）'}`,
  ]
  if (payload.scope) lines.push(`   范围 ${payload.scope}`)
  if (payload.a && payload.b) lines.push(`   来源 ${payload.a} + ${payload.b}`)
  if (payload.id) lines.push(`   对象 ${payload.id}`)
  if (payload.domain) lines.push(`   领域 ${payload.domain}`)
  lines.push(`   [要] kb exp decide ${row.seq} --yes   [改] 加 --claim "改后的判断"   [不要] --no`)
  return lines.join('\n')
}

