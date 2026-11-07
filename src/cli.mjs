/**
 * 命令行入口。所有子命令都是薄壳，真正的逻辑在各模块里。
 *
 * 命令一览见 `kb help`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initHome, kbHome, layout, readConfig } from './config.mjs'
import {
  openDb, upsertBlock, getBlock, listBlocks, searchBlocks, softDelete, counts, orphans,
} from './db.mjs'
import { readBlockFile, writeBlockFile, moveToTrash } from './blocks.mjs'
import { buildCandidate, captureMaterial } from './capture.mjs'
import { pending, accept, reject, describe, pendingCount } from './review.mjs'
import {
  makeExperience, applyUse, recordOccurrence, refine, merge, transplant, refute,
  vote, pin, promote, experienceOf, priority, explain, listExperiences, scoreText,
  orphanExperiences,
} from './experience.mjs'
import { repair } from './mapping.mjs'
import { submit, listProposals, decide as decideProposal, probationItems, card } from './proposals.mjs'
import { loadSettings, saveSettings, shouldNotify, ackNotification } from './settings.mjs'
import { startServer } from './server.mjs'
import { createBackup, listBackups, restoreBackup } from './backup.mjs'
import { loadGolden, evalInTemp, evalOnHome, formatReport } from './eval.mjs'
import { softSearch } from './consult.mjs'
import { searchWithWarnings, warningsForApply } from './warnings.mjs'
import { consult } from './consult.mjs'
import { planIngest, writePlan, applyPlan } from './ingest.mjs'
import { tidy } from './tidy.mjs'
import { parseOutline } from './outline.mjs'
import { clip } from './text.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const GOLDEN = path.join(ROOT, 'eval', 'golden.json')

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[body] = true
      else { flags[body] = next; i += 1 }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (value === undefined || value === true || value === '') throw new Error(`缺少 --${name}`)
  return String(value)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function bodyFromFlags(flags) {
  if (flags['body-file']) return fs.readFileSync(String(flags['body-file']), 'utf8')
  if (flags.body === '-') return readStdin()
  if (typeof flags.body === 'string') return flags.body
  return ''
}

// ---------- 小工具 ----------

function fmtTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function line(label, value) {
  return `${label.padEnd(10, ' ')} ${value}`
}

function open() {
  const home = kbHome()
  initHome(home)
  return { home, db: openDb(layout(home).db) }
}

function domainOf(flags) {
  return String(flags.domain ?? flags.area ?? '待分区')
}

// ---------- 子命令 ----------

function cmdInit() {
  const home = kbHome()
  const { created, layout: l, config } = initHome(home)
  console.log(created ? '已初始化知识库' : '知识库已存在，未改动')
  console.log(line('根目录', l.home))
  console.log(line('正文', l.blocks))
  console.log(line('索引', l.db))
  console.log(line('回收站', l.trash))
  console.log(line('建档时间', fmtTime(config.createdAt)))
  return 0
}

async function cmdAdd(flags, positional, { queue = false } = {}) {
  if (flags.type === 'experience') throw new Error('经验块请用：kb exp add --claim ...')
  const { home, db } = open()
  const input = {
    title: requireFlag(flags, 'title'),
    body: await bodyFromFlags(flags),
    summary: flags.summary ? String(flags.summary) : '',
    source: flags.source ? String(flags.source) : '',
    domain: domainOf(flags),
    primary_knowledge: flags.primary ? String(flags.primary) : '',
    kind: flags.kind ? String(flags.kind) : 'concept',
    tags: flags.tags ? String(flags.tags) : '',
  }
  if (flags['derived-from']) input.derived_from = String(flags['derived-from']).split(',').map((s) => s.trim()).filter(Boolean)

  if (queue) {
    const { seq, block } = captureMaterial(db, { ...input, reason: flags.reason ? String(flags.reason) : '手动录入' })
    console.log(`已进共判队列 #${seq}：${block.title}`)
    console.log(line('id', block.id))
    console.log(`待裁决 ${pendingCount(db)} 条，运行 \`kb review\` 查看`)
    return 0
  }

  const block = buildCandidate(input)
  const abs = writeBlockFile(home, block)
  upsertBlock(db, { ...block, path: abs })
  console.log(`已入库：${block.title}`)
  console.log(line('id', block.id))
  console.log(line('领域', block.domain))
  console.log(line('路径', abs))
  return 0
}

function cmdList(flags) {
  const { db } = open()
  const rows = listBlocks(db, {
    limit: Number(flags.limit ?? 20),
    type: flags.type ? String(flags.type) : undefined,
    status: flags.status ? String(flags.status) : undefined,
    domain: flags.domain ? String(flags.domain) : undefined,
  })
  if (!rows.length) { console.log('（空）'); return 0 }
  for (const row of rows) {
    const tag = row.type === 'experience' ? '经验' : '知识'
    const extra = row.orphaned ? ' ｜ 孤儿' : ''
    console.log(`${row.id}  [${tag}] ${row.title}  ｜ ${row.domain}${extra}`)
    console.log(`   ${clip(row.summary, 70) || '（无简介）'}`)
  }
  console.log(`\n共 ${rows.length} 条（最近在前）`)
  return 0
}

function printExperience(row, meta) {
  const exp = meta
  console.log(line('id', row.id))
  console.log(line('类型', `经验 / ${exp.kind}${exp.tier === 'probation' ? '（小经验区）' : ''}`))
  console.log(line('领域', `${exp.domain}${exp.orphaned ? '（孤儿）' : ''}`))
  console.log(line('判断', exp.claim))
  console.log(line('范围', exp.scope || '（未填）'))
  console.log(line('边界', exp.limits || '（未填）'))
  console.log(line('状态', exp.status))
  console.log(line('优先级', `${exp.priority ?? priority(exp)}  ← ${explain(exp)}`))
  console.log(line('账', `使用 ${exp.accounting.used}｜成功 ${exp.accounting.succeeded}｜复现 ${exp.accounting.occurrences}｜补充 ${exp.accounting.refined}｜人票 ${exp.accounting.human_vote}`))
  console.log(line('成功率', scoreText(exp)))
  const lin = exp.lineage
  if (lin.fused_from.length) console.log(line('融合自', lin.fused_from.join(', ')))
  if (lin.derived_from.length) console.log(line('派生自', lin.derived_from.join(', ')))
  if (lin.superseded_by) console.log(line('被替代', lin.superseded_by))
  if (lin.refuted_by.length) console.log(line('反证', lin.refuted_by.join(', ')))
  if (exp.primary_knowledge) console.log(line('主归属', exp.primary_knowledge))
  console.log(line('路径', row.path))
}

function cmdShow(positional) {
  const { db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb show <id>')
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  const meta = readBlockFile(row.path)

  if (row.type === 'experience') {
    printExperience(row, { ...meta, priority: priority(meta) })
    return 0
  }

  console.log(line('id', row.id))
  console.log(line('标题', row.title))
  console.log(line('类型', `知识 / ${row.kind || 'concept'}`))
  console.log(line('标签', (meta.tags ?? []).join(', ') || '（无）'))
  console.log(line('简介', row.summary || '（无）'))
  console.log(line('来源', row.source || '（无）'))
  console.log(line('领域', row.domain))
  console.log(line('状态', row.status))
  console.log(line('创建', fmtTime(row.created_at)))
  console.log(line('修改', fmtTime(row.modified_at)))
  console.log(line('版本', row.version))
  console.log(line('路径', row.path))

  const outline = parseOutline(meta.body)
  if (outline.length) {
    console.log('')
    console.log(`目录（${outline.length} 节）：`)
    for (const item of outline) console.log(`  ${'  '.repeat(item.level - 2)}${item.title}`)
  }

  const related = db.prepare(`SELECT id, title, status FROM blocks
    WHERE type='experience' AND primary_knowledge = ? AND deleted_at IS NULL`).all(id)
  if (related.length) {
    console.log('')
    console.log(`这个块长出的经验（${related.length} 条）：`)
    for (const r of related) console.log(`  ${r.id}  ${r.title}${r.status === 'refuted' ? '（已推翻）' : ''}`)
  }
  return 0
}

function cmdRead(positional) {
  const { db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb read <id>')
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  const meta = readBlockFile(row.path)
  process.stdout.write(`${meta.body.trim()}\n`)
  return 0
}

function cmdToc(positional) {
  const { db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb toc <id>')
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  if (row.type !== 'knowledge') throw new Error('只有知识块有目录；经验块是固定卡片')
  const meta = readBlockFile(row.path)
  const outline = parseOutline(meta.body)
  if (!outline.length) { console.log('（没有二级/三级标题）'); return 0 }
  for (const item of outline) console.log(`${'  '.repeat(item.level - 2)}- ${item.title}`)
  return 0
}

function cmdPath(positional) {
  const { db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb path <id>')
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  console.log(row.path)
  return 0
}

function cmdSearch(flags, positional) {
  const { db } = open()
  const query = positional.join(' ').trim()
  if (!query) throw new Error('用法：kb search <关键词>')
  let { rows, warnings } = searchWithWarnings(db, query, {
    limit: Number(flags.limit ?? 10),
    includeRefuted: Boolean(flags['include-refuted']),
  })
  // 整句不命中时拆词兜底（consult 也走这条路）
  if (!rows.length) rows = softSearch(db, query, Number(flags.limit ?? 10))
  if (!rows.length && !warnings.length) { console.log(`没有命中「${query}」`); return 1 }
  for (const [i, row] of rows.entries()) {
    const tag = row.type === 'experience' ? `经验/${row.kind}` : '知识'
    console.log(`${i + 1}. ${row.title}  [${tag}]  ${row.id}`)
    console.log(`   ${clip(row.summary, 90) || '（无简介）'}`)
    console.log(`   ${row.domain} ｜ 来源 ${row.source || '（无）'} ｜ ${row.path}`)
  }
  if (warnings.length) {
    console.log('\n⚠ 反例（不占正文名额，仅供参考）：')
    for (const warning of warnings) {
      console.log(`- ${warning.claim}`)
      console.log(`  ${warning.id} ｜ ${warning.domain} ｜ 被 ${warning.refuted_by.join(', ') || '（未填）'} 推翻`)
      if (warning.scope) console.log(`  适用范围：${warning.scope}`)
    }
  }
  console.log(`\n命中 ${rows.length} 条；要看正文用 \`kb read <id>\``)
  return 0
}

function cmdConsult(flags, positional) {
  const { db } = open()
  const query = positional.join(' ').trim()
  if (!query) throw new Error('用法：kb consult "问题"')
  const result = consult(db, query, { limit: Number(flags.limit ?? 5) })
  if (!result.consult) {
    console.log(`不查库：${result.reason}`)
    return 0
  }
  console.log('判定：查库')
  console.log('索引摘要：')
  console.log(result.summary)
  console.log(`\n命中 ${result.rows.length} 条：`)
  for (const row of result.rows) {
    const tag = row.type === 'experience' ? '经验' : '知识'
    console.log(`- ${row.id}｜${row.domain}｜[${tag}] ${row.title}`)
    console.log(`  ${clip(row.summary, 80) || '（无简介）'}`)
  }
  if (result.warnings.length) {
    console.log(`\n⚠ 反例 ${result.warnings.length} 条：`)
    for (const w of result.warnings) console.log(`- ${w.claim}（被 ${w.refuted_by.join(', ') || '未填'} 推翻）`)
  }
  return 0
}

function cmdIngest(flags, positional) {
  const { home, db } = open()
  if (flags.apply) {
    const file = typeof flags.apply === 'string' ? flags.apply : positional[0]
    if (!file) throw new Error('用法：kb ingest --apply <计划文件> [--domain 分区/主题]')
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'))
    const created = applyPlan(db, home, plan, { domain: typeof flags.domain === 'string' ? flags.domain : '' })
    for (const item of created) console.log(`${item.id}  ${item.domain}  ${item.title}`)
    console.log(`\n已入库 ${created.length} 条`)
    return 0
  }

  const file = positional[0]
  if (!file) throw new Error('用法：kb ingest <文件> [--title 标题]（只出计划，不动库）')
  const text = fs.readFileSync(file, 'utf8')
  const title = flags.title ? String(flags.title) : path.basename(file).replace(/\.[^.]+$/, '')
  const plan = planIngest(db, { title, text })
  const planFile = writePlan(home, plan)
  console.log(`分成 ${plan.chunks.length} 块，候选分区：\n`)
  for (const chunk of plan.chunks) {
    const top = chunk.suggestions.map((s) => `${s.domain}(${s.score})`).join('、') || '（无候选）'
    console.log(`#${chunk.index + 1} ${chunk.title}`)
    console.log(`   候选：${top}`)
  }
  console.log(`\n计划写到：${planFile}`)
  console.log('改完 chosen 字段后跑：kb ingest --apply 该文件')
  return 0
}

function parseSeqList(value, total) {
  if (value === true || value === 'all') return Array.from({ length: total }, (_, i) => i + 1)
  return String(value).split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
}

function cmdReview(flags) {
  const { home, db } = open()
  const limit = Number(flags.limit ?? 7)
  const rows = pending(db, limit)
  if (!rows.length) { console.log('没有待裁决的候选'); return 0 }

  console.log(`待裁决 ${rows.length} 条（本批上限 ${limit}）：\n`)
  rows.forEach((row, i) => console.log(`${describe(row, i + 1)}\n`))

  const acceptList = flags.accept !== undefined ? parseSeqList(flags.accept, rows.length) : []
  const rejectList = flags.reject !== undefined ? parseSeqList(flags.reject, rows.length) : []
  if (!acceptList.length && !rejectList.length) {
    console.log('裁决：`kb review --accept 1,3 --reject 2`，或 `--accept all` / `--reject all`')
    return 0
  }

  for (const n of acceptList) {
    if (n < 1 || n > rows.length) throw new Error(`序号越界：${n}`)
    const block = accept(db, home, rows[n - 1].seq)
    console.log(`接受 #${n} → ${block.id}  ${block.title}`)
  }
  for (const n of rejectList) {
    if (n < 1 || n > rows.length) throw new Error(`序号越界：${n}`)
    reject(db, rows[n - 1].seq)
    console.log(`否决 #${n}`)
  }
  console.log(`\n剩余待裁决 ${pendingCount(db)} 条`)
  return 0
}

function cmdRewrite(flags, positional) {
  const { db } = open()
  const seq = Number(positional[0])
  if (!Number.isInteger(seq)) throw new Error('用法：kb rewrite <候选序号> --title ... --summary ...')
  const row = db.prepare('SELECT payload FROM candidates WHERE seq = ?').get(seq)
  if (!row) throw new Error(`候选不存在：${seq}`)
  const payload = JSON.parse(row.payload)
  if (flags.title) payload.title = String(flags.title)
  if (flags.summary) payload.summary = String(flags.summary)
  db.prepare('UPDATE candidates SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), seq)
  console.log(`候选 #${seq} 已改写：${payload.title}`)
  return 0
}

// ---------- 经验 ----------

function cmdExpAdd(flags) {
  const { home, db } = open()
  const exp = makeExperience({
    claim: requireFlag(flags, 'claim'),
    kind: flags.kind ? String(flags.kind) : 'insight',
    scope: flags.scope ? String(flags.scope) : '',
    limits: flags.limits ? String(flags.limits) : '',
    domain: domainOf(flags),
    tier: flags.tier ? String(flags.tier) : 'main',
    status: flags.status ? String(flags.status) : 'candidate',
    primary_knowledge: flags.primary ? String(flags.primary) : '',
    source: flags.source ? String(flags.source) : '',
    body: flags.body ? String(flags.body) : '',
  })
  const abs = writeBlockFile(home, exp)
  upsertBlock(db, { ...exp, path: abs, body: exp.body })
  console.log(`已记一条经验：${exp.claim}`)
  console.log(line('id', exp.id))
  console.log(line('领域', exp.domain))
  console.log(line('优先级', priority(exp)))
  return 0
}

function cmdExpApply(positional, flags) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp apply <id> [--result success|failure] [--method self|human|signal]')
  const result = ['success', 'failure', 'unknown'].includes(String(flags.result)) ? String(flags.result) : 'unknown'
  const method = ['self', 'human', 'signal'].includes(String(flags.method)) ? String(flags.method) : 'self'
  // 套用前先看有没有反例（D-031：警示只在"要踩坑的那一刻"出现）
  const warnings = warningsForApply(db, id)
  if (warnings.length) {
    console.log('⚠ 这条经验有反例：')
    for (const warning of warnings) {
      console.log(`- ${warning.claim}（被 ${warning.refuted_by.join(', ') || '未填'} 推翻）`)
      if (warning.scope) console.log(`  适用范围：${warning.scope}`)
    }
    console.log('')
  }
  const exp = applyUse(db, home, id, { result, method, note: flags.note ? String(flags.note) : '' })
  console.log(`已记账：使用 ${exp.accounting.used}｜成功 ${exp.accounting.succeeded}｜优先级 ${priority(exp)}`)
  return 0
}

function cmdExpHit(positional) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp hit <id>')
  const exp = recordOccurrence(db, home, id)
  console.log(`已记一次复现：共 ${exp.accounting.occurrences} 次｜优先级 ${priority(exp)}`)
  return 0
}

function cmdExpRefine(positional, flags) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp refine <id> --note "补了什么"')
  const exp = refine(db, home, id, { note: flags.note ? String(flags.note) : '' })
  console.log(`已补充：共 ${exp.accounting.refined} 次｜版本 ${exp.version}｜优先级 ${priority(exp)}`)
  return 0
}

function cmdExpMerge(positional, flags) {
  const { home, db } = open()
  const [a, b] = positional
  if (!a || !b) throw new Error('用法：kb exp merge <idA> <idB> --claim "融合后的判断" [--domain 领域]')
  const claim = requireFlag(flags, 'claim')
  const exp = merge(db, home, a, b, {
    claim,
    scope: flags.scope ? String(flags.scope) : '',
    domain: flags.domain ? String(flags.domain) : undefined,
  })
  console.log(`已融合出新的经验：${exp.claim}`)
  console.log(line('id', exp.id))
  console.log(line('领域', exp.domain))
  console.log(line('来源', `${a} + ${b}`))
  return 0
}

function cmdExpTransplant(positional, flags) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp transplant <id> --domain 目标领域')
  const exp = transplant(db, home, id, {
    domain: requireFlag(flags, 'domain'),
    claim: flags.claim ? String(flags.claim) : undefined,
    scope: flags.scope ? String(flags.scope) : '',
  })
  console.log(`已派生到「${exp.domain}」：${exp.claim}`)
  console.log(line('id', exp.id))
  console.log(line('父经验', id))
  return 0
}

function cmdExpRefute(positional, flags) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp refute <id> --by "反例/证据"')
  const exp = refute(db, home, id, { by: flags.by ? String(flags.by) : '', note: flags.note ? String(flags.note) : '' })
  console.log(`已推翻：${exp.claim}`)
  console.log('保留在库里当反例，默认不再出现在检索结果')
  return 0
}

function cmdExpVote(positional) {
  const { home, db } = open()
  const id = positional[0]
  const value = Number(positional[1])
  if (!id || ![1, -1].includes(value)) throw new Error('用法：kb exp vote <id> +1|-1')
  const exp = vote(db, home, id, value)
  console.log(`已投票：人票 ${exp.accounting.human_vote}｜优先级 ${priority(exp)}`)
  return 0
}

function cmdExpPin(positional, flags) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp pin <id> [--off]')
  const exp = pin(db, home, id, !flags.off)
  console.log(flags.off ? `已取消置顶：${id}` : `已置顶：${id}`)
  console.log(line('优先级', priority(exp)))
  return 0
}

function cmdExpPromote(positional) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp promote <id>')
  const exp = promote(db, home, id)
  console.log(`已转正进主库：${exp.claim}`)
  return 0
}

function cmdExpShow(positional) {
  const { db, home } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp show <id>')
  const { row, exp } = experienceOf(db, home, id)
  printExperience(row, { ...exp, priority: priority(exp) })
  return 0
}

function cmdExpList(flags) {
  const { db, home } = open()
  const rows = listExperiences(db, home, {
    includeRefuted: Boolean(flags['include-refuted']),
    domain: flags.domain ? String(flags.domain) : undefined,
    limit: Number(flags.limit ?? 20),
  })
  if (!rows.length) { console.log('（没有经验）'); return 0 }
  for (const [i, exp] of rows.entries()) {
    const tier = exp.tier === 'probation' ? '小经验区' : '主库'
    const state = exp.status === 'refuted' ? '已推翻' : exp.status
    console.log(`${i + 1}. [${exp.kind}/${tier}] ${exp.claim}`)
    console.log(`   ${exp.id} ｜ ${exp.domain} ｜ ${state} ｜ 优先级 ${exp.priority}  ← ${explain(exp)}`)
  }
  console.log(`\n共 ${rows.length} 条（按优先级排）`)
  return 0
}

function cmdExpRefuted(flags) {
  const { db, home } = open()
  const rows = listExperiences(db, home, { includeRefuted: true, limit: 50 }).filter((e) => e.status === 'refuted')
  if (!rows.length) { console.log('（没有反例）'); return 0 }
  console.log('反例（被推翻的经验）：')
  for (const exp of rows) {
    console.log(`- ${exp.claim}`)
    console.log(`  ${exp.id} ｜ ${exp.domain} ｜ 反证 ${exp.lineage.refuted_by.join(', ') || '（未填）'}`)
  }
  return 0
}

function cmdOrphans() {
  const { db } = open()
  const rows = orphans(db)
  if (!rows.length) { console.log('（没有孤儿经验）'); return 0 }
  console.log('孤儿经验（来源知识块已删）：')
  for (const row of rows) console.log(`- ${row.id}  ${row.title}  ｜ ${row.domain}`)
  return 0
}

function cmdRm(positional) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb rm <id>')
  const row = getBlock(db, id)
  if (!row) throw new Error(`找不到：${id}`)
  if (row.deleted_at) throw new Error(`已经删过了：${id}`)
  if (fs.existsSync(row.path)) moveToTrash(home, row.path, id)
  softDelete(db, id, new Date().toISOString())
  console.log(`已删除（进回收站，未物理删除）：${id}`)
  if (row.type === 'knowledge') {
    const marked = orphanExperiences(db, home, id)
    if (marked.length) console.log(`挂在这条知识上的经验转为孤儿（不连坐）：${marked.join(', ')}`)
  }
  return 0
}

function cmdRepair() {
  const { home, db } = open()
  const report = repair(db, home)
  console.log('映射检查完成：')
  console.log(line('收编', report.adopted.length ? report.adopted.join(', ') : '无'))
  console.log(line('重映射', report.remapped.length ? report.remapped.map((r) => r.id).join(', ') : '无'))
  console.log(line('冲突', report.conflicts.length ? report.conflicts.map((c) => c.id).join(', ') : '无'))
  console.log(line('丢失', report.missing.length ? report.missing.map((m) => m.id).join(', ') : '无'))
  console.log(line('孤儿', report.orphaned.length ? report.orphaned.join(', ') : '无'))
  if (report.broken.length) {
    console.log('坏文件：')
    for (const b of report.broken) console.log(`  ${b.path}  ${b.error}`)
  }
  return report.broken.length ? 1 : 0
}

function cmdSettings(positional, flags) {
  const { home } = open()
  if (positional[0] === 'set') {
    const key = positional[1]
    const raw = positional[2]
    if (!key || raw === undefined) throw new Error('用法：kb settings set experience.mode review')
    const value = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
    const patch = key.split('.').reduceRight((acc, k) => ({ [k]: acc }), value)
    const settings = saveSettings(home, patch)
    console.log(JSON.stringify(settings.experience, null, 2))
    return 0
  }
  const s = loadSettings(home).experience
  console.log('经验设置：')
  console.log(line('模式', `${s.mode}（review 审核 / auto 小经验区 / off 关闭）`))
  console.log(line('审核', `每天最多 ${s.review.maxPerDay} 条，同主题冷却 ${s.review.cooldownHours} 小时`))
  console.log(line('免审', `每天最多 ${s.auto.maxPerDay} 条，攒 ${s.auto.notifyEvery} 条或 ${s.auto.notifyAfterDays} 天通知`))
  return 0
}

function printWarnings(warnings) {
  if (!warnings?.length) return
  console.log('提示（不影响提交，由人判断）：')
  for (const line of warnings) console.log(`  - ${line}`)
}

function reportSubmit(result) {
  if (result.status === 'off') { console.log(result.reason); return 0 }
  if (result.status === 'skipped') { console.log(`这次不打扰：${result.reason}`); printWarnings(result.warnings); return 0 }
  if (result.status === 'pending') {
    console.log(`已提案 #${result.seq}，等你拍板：kb exp proposals`)
    printWarnings(result.warnings)
    return 0
  }
  console.log(`已进小经验区：${result.id}`)
  printWarnings(result.warnings)
  if (result.notify?.notify) console.log(`该看一批了：${result.notify.reason}（kb exp inbox）`)
  return 0
}

function cmdExpPropose(flags) {
  const { home, db } = open()
  const claim = requireFlag(flags, 'claim')
  const payload = {
    claim,
    kind: flags.kind ? String(flags.kind) : 'insight',
    scope: flags.scope ? String(flags.scope) : '',
    limits: flags.limits ? String(flags.limits) : '',
    domain: domainOf(flags),
    primary_knowledge: flags.primary ? String(flags.primary) : '',
    source: flags.source ? String(flags.source) : '',
  }
  const result = submit(db, home, {
    action: 'new',
    payload,
    reason: flags.reason ? String(flags.reason) : '',
    proposedClaim: claim,
  })
  return reportSubmit(result)
}

function cmdExpProposeMerge(positional, flags) {
  const { home, db } = open()
  const [a, b] = positional
  if (!a || !b) throw new Error('用法：kb exp propose-merge <a> <b> --claim "融合后的判断"')
  const claim = requireFlag(flags, 'claim')
  const result = submit(db, home, {
    action: 'merge',
    payload: { a, b, claim, scope: flags.scope ? String(flags.scope) : '', domain: flags.domain ? String(flags.domain) : undefined },
    reason: flags.reason ? String(flags.reason) : '',
    proposedClaim: claim,
  })
  return reportSubmit(result)
}

function cmdExpProposeTransplant(positional, flags) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp propose-transplant <id> --domain 目标领域')
  const result = submit(db, home, {
    action: 'transplant',
    payload: { id, domain: requireFlag(flags, 'domain'), claim: flags.claim ? String(flags.claim) : undefined },
    reason: flags.reason ? String(flags.reason) : '',
  })
  return reportSubmit(result)
}

function cmdExpProposeRefute(positional, flags) {
  const { home, db } = open()
  const id = positional[0]
  if (!id) throw new Error('用法：kb exp propose-refute <id> --by "反证"')
  const result = submit(db, home, {
    action: 'refute',
    payload: { id, by: flags.by ? String(flags.by) : '', note: flags.note ? String(flags.note) : '' },
    reason: flags.reason ? String(flags.reason) : '发现反例',
  })
  return reportSubmit(result)
}

function cmdExpProposals() {
  const { db } = open()
  const rows = listProposals(db)
  if (!rows.length) { console.log('没有待拍板的提议'); return 0 }
  console.log(`待拍板 ${rows.length} 条：\n`)
  rows.forEach((row, i) => console.log(`${card(row, i + 1)}\n`))
  return 0
}

function cmdExpDecide(positional, flags) {
  const { home, db } = open()
  const seq = Number(positional[0])
  if (!Number.isInteger(seq)) throw new Error('用法：kb exp decide <序号> --yes|--no [--claim "改后的判断"]')
  if (!flags.yes && !flags.no) throw new Error('要 --yes 或 --no')
  const res = decideProposal(db, home, seq, {
    yes: Boolean(flags.yes) && !flags.no,
    note: flags.note ? String(flags.note) : '',
    claim: flags.claim ? String(flags.claim) : undefined,
  })
  if (res.status === 'rejected') console.log(`已否决 #${seq}（留档）`)
  else console.log(`已接受 #${seq} → ${res.id}\n${res.claim}`)
  printWarnings(res.warnings)
  return 0
}

function cmdExpInbox(flags) {
  const { home, db } = open()
  const rows = probationItems(db)
  if (!rows.length) { console.log('小经验区是空的'); return 0 }
  console.log(`小经验区 ${rows.length} 条（未转正）：`)
  for (const exp of rows) {
    console.log(`- ${exp.claim}`)
    console.log(`  ${exp.id} ｜ ${exp.domain} ｜ 优先级 ${priority(exp)}  ← ${explain(exp)}`)
  }
  console.log('\n转正：kb exp promote <id>；废掉：kb exp refute <id> --by "..."')
  const n = shouldNotify(home, loadSettings(home))
  if (n.notify) console.log(`\n提示：${n.reason}`)
  if (flags.ack) {
    ackNotification(home)
    console.log('\n已确认本批通知，计数清零')
  }
  return 0
}

function cmdTidy(flags) {
  const { home, db } = open()
  const report = tidy(db, home, { apply: Boolean(flags.apply) })
  console.log('整理报告（算法，0 token）')
  console.log(line('块', `${report.totals.blocks} 条`))
  console.log(line('新变更', `${report.totals.changed} 条`))
  console.log(line('缺摘要', `${report.totals.missingSummary} 条`))
  console.log(line('疑似重复', `${report.totals.duplicates} 组（${report.totals.duplicatePairs} 对）`))
  console.log(line('候选关联', `${report.totals.links} 对`))
  console.log(line('任务包', `${report.totals.tasks} 个`))
  if (report.applied.length) console.log(line('已补摘要', `${report.applied.length} 条`))
  else console.log('\n只报告不改库；加 --apply 只补「简介为空」的块，已有简介不动。')
  console.log(line('报告', report.paths.report))
  console.log(line('任务包', report.paths.tasks))
  return 0
}

function cmdEval(flags) {
  const setPath = flags.set ? String(flags.set) : GOLDEN
  const golden = loadGolden(setPath)
  const report = flags.home ? evalOnHome(String(flags.home), golden) : evalInTemp(golden)
  console.log(`检索契约 v${golden.version}：语料 ${golden.corpus.length} 条，查询 ${golden.queries.length} 条\n`)
  console.log(formatReport(report))
  return report.recall === 1 ? 0 : 1
}

function cmdServe(flags) {
  const home = kbHome()
  const port = Number(flags.port ?? 7788)
  const { url } = startServer({ home, port })
  console.log(`本地知识库面板已启动：${url}`)
  console.log('只监听 127.0.0.1；关掉这个进程就停。')
  return new Promise(() => { /* 保持进程存活，交给 Ctrl+C */ })
}

function cmdBackup(flags) {
  const home = kbHome()
  initHome(home)
  const result = createBackup(home, { out: flags.out })
  console.log(`已备份：${result.path}`)
  console.log(`文件 ${result.files} 个，压缩包 ${(result.bytes / 1024 / 1024).toFixed(2)} MB`)
}

function cmdBackups() {
  const home = kbHome()
  initHome(home)
  const items = listBackups(home)
  if (!items.length) {
    console.log('还没有备份。用 kb backup 建一个。')
    return 0
  }
  for (const [index, item] of items.entries()) {
    console.log(`${index + 1}. ${item.name}  ${(item.bytes / 1024 / 1024).toFixed(2)} MB  ${item.mtime}`)
  }
}

function cmdRestore(positional, flags) {
  const home = kbHome()
  initHome(home)
  const source = positional[0]
  if (!source) throw new Error('用法：kb restore <备份.zip> [--merge] [--dry-run]')
  const mode = flags.merge ? 'merge' : 'overwrite'
  const result = restoreBackup(home, path.resolve(source), { mode, dryRun: Boolean(flags['dry-run']) })
  const tag = flags['dry-run'] ? '（演练，未写盘）' : ''
  console.log(`恢复${tag}：模式 ${result.mode}`)
  console.log(`新建 ${result.created}，覆盖 ${result.updated}，相同跳过 ${result.skipped}，删除 ${result.removed}`)
  if (result.safetyBackup) console.log(`恢复前安全备份：${result.safetyBackup}`)
}

function cmdStats() {
  const { home, db } = open()
  const c = counts(db)
  const config = readConfig(home)
  console.log(`知识库：${config?.name ?? '未命名'}`)
  console.log(line('根目录', home))
  console.log(line('块', `${c.blocks} 条（知识 ${c.knowledge}，经验 ${c.experience}）`))
  console.log(line('小经验区', `${c.probation} 条`))
  console.log(line('已推翻', `${c.refuted} 条`))
  console.log(line('待共判', `${c.pending} 条`))
  console.log(line('待拍板', `${c.proposals} 条`))
  console.log(line('回收站', `${c.deleted} 条`))
  return 0
}

function cmdHelp() {
  console.log(`kb —— 本地知识库命令行（R0）

  知识
  kb init
  kb add --title T [--body B|--body-file F|-] [--source U] [--domain D] [--summary S] [--primary ID]
         [--kind concept|howto|troubleshoot|reference|tutorial|decision|code|faq] [--tags a,b]
  kb toc <id>                                       看知识块的目录
  kb capture --title T --body B [--reason R]       只进候选队列
  kb review [--limit 7] [--accept 1,2|all] [--reject 3|all]
  kb rewrite <候选序号> --title ... --summary ...
  kb search <关键词> [--limit N] [--include-refuted]
  kb read <id> / kb show <id> / kb path <id>
  kb list [--limit N] [--type knowledge|experience] [--domain D]
  kb rm <id>                                       逻辑删除（进 _trash）
  kb repair                                        重扫明文，修映射与孤儿

  经验
  kb exp add --claim "一句话判断" [--kind insight|fusion|transfer]
             [--scope "适用条件"] [--limits "何时不成立"] [--domain D]
             [--primary 知识块id] [--tier main|probation] [--body "..."]
  kb exp apply <id> [--result success|failure] [--method self|human|signal]
  kb exp hit <id>                                  复现 +1
  kb exp refine <id> --note "补了什么"             补充 +1
  kb exp merge <a> <b> --claim "融合后的判断" [--domain D]
  kb exp transplant <id> --domain 目标领域
  kb exp refute <id> --by "反证"
  kb exp vote <id> +1|-1
  kb exp pin <id> [--off]
  kb exp promote <id>                              小经验区 → 主库
  kb exp show <id> / kb exp list [--include-refuted] / kb exp refuted

  提议与拍板
  kb settings [set experience.mode review|auto|off]
  kb exp propose --claim "…" --reason "为什么值得记" [--kind …] [--scope …] [--domain D]
  kb exp propose-merge <a> <b> --claim "融合后的判断"
  kb exp propose-transplant <id> --domain 目标领域
  kb exp propose-refute <id> --by "反证"
  kb exp proposals                                  看待拍板的提议
  kb exp decide <序号> --yes|--no [--claim "改后的判断"]
  kb exp inbox [--ack]                              看小经验区

  kb orphans / kb stats

  kb serve [--port 7788]                            打开本地界面（浏览器访问）

  备份
  kb backup [--out 文件.zip]                       整库备份（明文 + 索引 + 回收站，一个包）
  kb backups                                        列出本地备份
  kb restore <备份.zip> [--merge] [--dry-run]       恢复：默认覆盖，--merge 增量去重，--dry-run 演练
  kb eval [--home 目录] [--set 文件]                跑检索契约（默认在临时库，不动你的数据）
  kb tidy [--apply]                                 算法整理：变更/摘要/重复/关联候选（0 token）
`)
  return 0
}

// ---------- 分发 ----------

export async function run(argv) {
  const [command, ...rest] = argv
  const { flags, positional } = parseArgs(rest)
  switch (command) {
    case undefined:
    case 'help': return cmdHelp()
    case 'init': return cmdInit()
    case 'add': return cmdAdd(flags, positional)
    case 'capture': return cmdAdd(flags, positional, { queue: true })
    case 'list': return cmdList(flags)
    case 'show': return cmdShow(positional)
    case 'read': return cmdRead(positional)
    case 'toc': return cmdToc(positional)
    case 'path': return cmdPath(positional)
    case 'search': return cmdSearch(flags, positional)
    case 'consult': return cmdConsult(flags, positional)
    case 'ingest': return cmdIngest(flags, positional)
    case 'review': return cmdReview(flags)
    case 'rewrite': return cmdRewrite(flags, positional)
    case 'rm': return cmdRm(positional)
    case 'repair': return cmdRepair()
    case 'stats': return cmdStats()
    case 'backup': return cmdBackup(flags)
    case 'backups': return cmdBackups()
    case 'restore': return cmdRestore(positional, flags)
    case 'orphans': return cmdOrphans()
    case 'settings': return cmdSettings(positional, flags)
    case 'serve': return cmdServe(flags)
    case 'eval': return cmdEval(flags)
    case 'tidy': return cmdTidy(flags)
    case 'exp': {
      const [sub, ...args] = rest
      const parsed = parseArgs(args)
      switch (sub) {
        case 'add': return cmdExpAdd(parsed.flags)
        case 'apply': return cmdExpApply(parsed.positional, parsed.flags)
        case 'hit': return cmdExpHit(parsed.positional)
        case 'refine': return cmdExpRefine(parsed.positional, parsed.flags)
        case 'merge': return cmdExpMerge(parsed.positional, parsed.flags)
        case 'transplant': return cmdExpTransplant(parsed.positional, parsed.flags)
        case 'refute': return cmdExpRefute(parsed.positional, parsed.flags)
        case 'vote': return cmdExpVote(parsed.positional)
        case 'pin': return cmdExpPin(parsed.positional, parsed.flags)
        case 'promote': return cmdExpPromote(parsed.positional)
        case 'show': return cmdExpShow(parsed.positional)
        case 'list': return cmdExpList(parsed.flags)
        case 'refuted': return cmdExpRefuted(parsed.flags)
        case 'propose': return cmdExpPropose(parsed.flags)
        case 'propose-merge': return cmdExpProposeMerge(parsed.positional, parsed.flags)
        case 'propose-transplant': return cmdExpProposeTransplant(parsed.positional, parsed.flags)
        case 'propose-refute': return cmdExpProposeRefute(parsed.positional, parsed.flags)
        case 'proposals': return cmdExpProposals()
        case 'decide': return cmdExpDecide(parsed.positional, parsed.flags)
        case 'inbox': return cmdExpInbox(parsed.flags)
        default: throw new Error('用法：kb exp <add|apply|hit|refine|merge|transplant|refute|vote|pin|promote|show|list|refuted>')
      }
    }
    default:
      throw new Error(`未知命令：${command}（看 kb help）`)
  }
}




