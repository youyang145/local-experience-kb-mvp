/**
 * 块的落盘与读回（KB0 的"文件夹"半身）。
 *
 * 一个块 = 一个 .md 文件：块头 + 正文。
 * 路径：blocks/<领域>/<knowledge|experience>/<分片>/<id>.md
 *   —— 经验按"出生领域"归档，和同领域的知识并排（D-025）。
 * 删除不是 unlink，而是搬进 _trash（项目约定不许物理删除）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs'
import { shardOf } from './ids.mjs'
import { layout } from './config.mjs'

/**
 * 领域 slug：支持"分区/主题"两级路径（D-034）。
 *
 * `工具/GG修改器` → `工具/GG修改器`（各级单独清洗，斜杠保留为目录分隔）。
 * 空段、`.`、`..` 一律拒绝，防止越出 blocks 根。
 */
export function domainSegments(domain) {
  const raw = String(domain ?? '').trim() || '待分区'
  const parts = raw.split(/[\\/]+/).map((part) => part.trim()).filter(Boolean)
  const safe = []
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`领域路径不合法：${raw}`)
    const cleaned = part.replace(/[:*?"<>|\u0000-\u001f]/g, '_')
    if (cleaned) safe.push(cleaned)
  }
  if (!safe.length) throw new Error(`领域不能为空`)
  return safe
}

export function domainSlug(domain) {
  return domainSegments(domain).join('/')
}

export function typeDir(type) {
  return type === 'experience' ? 'experience' : 'knowledge'
}

export function blockFilePath(home, block) {
  const l = layout(home)
  return path.join(l.blocks, ...domainSegments(block.domain ?? block.area), typeDir(block.type), shardOf(block.id), `${block.id}.md`)
}

export function blockToText(block) {
  const meta = {
    id: block.id,
    type: block.type ?? 'knowledge',
    title: block.title ?? '',
    summary: block.summary ?? '',
    source: block.source ?? '',
    domain: block.domain ?? block.area ?? '待分区',
    created_at: block.created_at,
    modified_at: block.modified_at ?? block.created_at,
    version: block.version ?? 1,
    editor: block.editor ?? 'local',
    status: block.status ?? 'unverified',
    content_hash: block.content_hash ?? '',
  }
  if (block.type === 'knowledge') {
    meta.kind = block.kind ?? 'concept'
    if (Array.isArray(block.tags) && block.tags.length) meta.tags = block.tags
  }
  if (block.type === 'experience') {
    meta.kind = block.kind ?? 'insight'
    meta.tier = block.tier ?? 'main'
    meta.claim = block.claim ?? block.title ?? ''
    if (block.scope) meta.scope = block.scope
    if (block.limits) meta.limits = block.limits
    if (block.primary_knowledge) meta.primary_knowledge = block.primary_knowledge
    if (block.orphaned) meta.orphaned = true
    meta.lineage = {
      fused_from: block.lineage?.fused_from ?? [],
      derived_from: block.lineage?.derived_from ?? [],
      superseded_by: block.lineage?.superseded_by ?? '',
      refuted_by: block.lineage?.refuted_by ?? [],
    }
    meta.accounting = {
      used: block.accounting?.used ?? 0,
      succeeded: block.accounting?.succeeded ?? 0,
      occurrences: block.accounting?.occurrences ?? 0,
      refined: block.accounting?.refined ?? 0,
      human_vote: block.accounting?.human_vote ?? 0,
      pinned: Boolean(block.accounting?.pinned),
      last_seen_at: block.accounting?.last_seen_at ?? '',
      last_used_at: block.accounting?.last_used_at ?? '',
    }
    if (Array.isArray(block.evidence) && block.evidence.length) meta.evidence = block.evidence
  }
  if (Array.isArray(block.derived_from) && block.derived_from.length) meta.derived_from = block.derived_from
  if (Array.isArray(block.links) && block.links.length) meta.links = block.links
  return serializeFrontmatter(meta, block.body ?? '')
}

/** 落盘并返回绝对路径。先写临时文件再 rename：写一半崩了不会留下半个块。 */
export function writeBlockFile(home, block) {
  const abs = blockFilePath(home, block)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, blockToText(block), 'utf8')
  fs.renameSync(tmp, abs)
  return abs
}

export function readBlockFile(abs) {
  const text = fs.readFileSync(abs, 'utf8')
  const { meta, body } = parseFrontmatter(text)
  if (!meta.id) throw new Error(`块文件缺少 id：${abs}`)
  if (!meta.domain && meta.area) meta.domain = meta.area
  return { ...meta, body, path: abs }
}

export function fileExists(abs) {
  return fs.existsSync(abs)
}

/** 递归列出所有块文件。 */
export function listBlockFiles(home) {
  const root = layout(home).blocks
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs)
    }
  }
  walk(root)
  return out
}

/** 逻辑删除：搬进 _trash，保留可追溯。 */
export function moveToTrash(home, abs, id) {
  const l = layout(home)
  fs.mkdirSync(l.trash, { recursive: true })
  const target = path.join(l.trash, `${id ?? path.basename(abs, '.md')}__${path.basename(abs)}`)
  fs.renameSync(abs, target)
  return target
}

/** 冲突文件不覆盖、不删除，单独隔离。 */
export function moveToConflicts(home, abs, suffix = '') {
  const l = layout(home)
  fs.mkdirSync(l.conflicts, { recursive: true })
  const target = path.join(l.conflicts, `${path.basename(abs, '.md')}${suffix}.md`)
  fs.renameSync(abs, target)
  return target
}

