/**
 * 收录管线（KB2）：三个入口只负责产出"候选块"，不决定要不要写。
 *
 * 本模块只做手动入口——给一段材料，产出一个结构一致的候选。
 * 上网搜集与 AI 自判属于后续轮次。
 */
import { newId, contentHash } from './ids.mjs'
import { clip } from './text.mjs'
import { enqueue } from './review.mjs'

/** 由原始材料构造候选块（不落盘）。 */
export function buildCandidate(input, { at = new Date(), salt } = {}) {
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('候选块必须有标题')
  const body = String(input.body ?? '').trim()
  const type = input.type === 'experience' ? 'experience' : 'knowledge'
  const domain = String(input.domain ?? input.area ?? '待分区').trim() || '待分区'
  const summary = input.summary ? clip(input.summary) : clip(body.replace(/\s+/g, ' '), 120)
  const created_at = at.toISOString()
  const block = {
    id: newId({ at, title, salt }),
    type,
    title,
    summary,
    source: String(input.source ?? '').trim(),
    domain,
    primary_knowledge: String(input.primary_knowledge ?? '').trim(),
    orphaned: false,
    created_at,
    modified_at: created_at,
    version: 1,
    editor: input.editor || 'local',
    status: 'unverified',
    content_hash: contentHash(body),
    body,
  }
  if (type === 'knowledge') {
    block.kind = String(input.kind ?? 'concept')
    block.tags = Array.isArray(input.tags) ? input.tags.filter(Boolean) : String(input.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (input.derived_from?.length) block.derived_from = input.derived_from
  return block
}

/** 手动录入：直接把材料变成候选并排队等共判。 */
export function captureMaterial(db, input, options = {}) {
  const block = buildCandidate(input, options)
  const seq = enqueue(db, block, input.reason ?? '手动录入')
  return { seq, block }
}

