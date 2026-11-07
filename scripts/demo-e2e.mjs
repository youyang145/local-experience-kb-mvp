/**
 * 骨架端到端演示：分区 → 资料入库 → 查库 → 经验记账 → 推翻 → 反例警示。
 *
 *   node scripts/demo-e2e.mjs
 *
 * 跑在系统临时目录建的干净库里，不碰演示库和正式库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock, listBlocks, counts } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile } from '../src/blocks.mjs'
import { consult } from '../src/consult.mjs'
import { planIngest, applyPlan } from '../src/ingest.mjs'
import { makeExperience, applyUse, refute, priority } from '../src/experience.mjs'
import { warningsForApply } from '../src/warnings.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demo-'))
const step = (n, text) => console.log(`\n[${n}] ${text}`)

console.log(`临时库：${home}`)
initHome(home)
const db = openDb(layout(home).db)

step(1, '存一条知识（工具/GG修改器）')
const gg = buildCandidate({
  title: 'GG 搜不到数值时先换类型',
  body: '数值类型选错是最常见原因；先换整数/浮点再搜。',
  domain: '工具/GG修改器',
  kind: 'troubleshoot',
}, { salt: 'demo-gg' })
upsertBlock(db, { ...gg, path: writeBlockFile(home, gg) })
console.log(`   ${gg.id}  ${gg.domain}  ${gg.title}`)

step(2, '把一段资料塞进来：自动分块 + 猜分区，只写「待分区」')
const material = '# 阴影原理\n\n从光源看深度。\n\n## 偏差\n\n需要 bias。\n\n## 级联\n\n近处高分辨率。'
const plan = planIngest(db, { title: '阴影笔记', text: material })
const staged = applyPlan(db, home, plan, { domain: '待分区' })
console.log(`   分 ${plan.chunks.length} 块，入库 ${staged.length} 块：${staged.map((s) => s.id).join(', ')}`)
console.log(`   待分区条数：${listBlocks(db, { domain: '待分区' }).length}`)

step(3, '查库：先判要不要查，再给索引摘要与命中')
const asked = consult(db, 'GG 搜不到数值怎么办', { limit: 3 })
console.log(`   判定：${asked.consult ? '查库' : '跳过'}（${asked.reason}）`)
console.log(`   命中：${asked.rows.map((r) => r.title).join(' / ') || '无'}`)

step(4, '记一条经验，套用成功两次')
const exp = makeExperience({
  claim: '搜不到数值时，先换数值类型再重搜。',
  scope: 'GG 修改器 / 内存搜索',
  limits: '数值被加密（XOR）时不适用',
  domain: '工具/GG修改器',
})
upsertBlock(db, { ...exp, path: writeBlockFile(home, exp) })
applyUse(db, home, exp.id, { result: 'success', method: 'self' })
const applied = applyUse(db, home, exp.id, { result: 'success', method: 'self' })
console.log(`   ${exp.id}  used=${applied.accounting.used}  succeeded=${applied.accounting.succeeded}  优先级=${priority(applied)}`)

step(5, '人推翻它：保留为反例，不删除')
refute(db, home, exp.id, { by: gg.id, note: 'XOR 加密场景下换类型无效' })
console.log(`   状态：${'refuted'}；检索默认不再推荐它`)

step(6, '套用一条相似经验前，反例警示出现')
const sibling = makeExperience({
  claim: '搜不到数值时先换类型试试。',
  scope: 'GG 修改器 / 搜索',
  domain: '工具/GG修改器',
})
upsertBlock(db, { ...sibling, path: writeBlockFile(home, sibling) })
const warns = warningsForApply(db, sibling.id)
console.log(`   警示 ${warns.length} 条：${warns.map((w) => w.claim).join(' / ') || '无'}`)

step(7, '收尾：统计')
console.log('   ', JSON.stringify(counts(db)))
db.close()
console.log(`\n演示结束。临时库保留在：${home}`)
