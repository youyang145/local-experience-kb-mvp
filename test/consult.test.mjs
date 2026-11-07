/**
 * 查库判定 + 资料入库（D-035 / P2b 算法半边）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile } from '../src/blocks.mjs'
import { shouldConsult, consult, indexSummary } from '../src/consult.mjs'
import { chunkText, planIngest, applyPlan } from '../src/ingest.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome() {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-'))
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ } },
  }
}

function seed(dir) {
  initHome(dir)
  const db = openDb(layout(dir).db)
  for (const [title, domain, body] of [
    ['GG 基础搜索流程', '工具/GG修改器', '选择进程，搜索，改善，修改。'],
    ['矩阵对角化', '数学', '把矩阵化成对角形再求幂。'],
  ]) {
    const block = buildCandidate({ title, body, domain }, { salt: title })
    upsertBlock(db, { ...block, path: writeBlockFile(dir, block) })
  }
  return db
}

test('查库判定：闲聊跳过，技术问题查', () => {
  assert.equal(shouldConsult('你好').yes, false)
  assert.equal(shouldConsult('谢谢！').yes, false)
  assert.equal(shouldConsult('GG 搜不到数值怎么办').yes, true)
})

test('查库：有索引摘要，整句不命中时拆词兜底', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = seed(dir)
    assert.match(indexSummary(db).text, /工具\/GG修改器（1）/)

    const result = consult(db, 'GG 修改器 搜索不到数值怎么办')
    assert.equal(result.consult, true)
    assert.equal(result.rows.length >= 1, true)
    assert.equal(result.rows[0].domain, '工具/GG修改器')
    db.close()
  } finally { cleanup() }
})

test('入库：按标题分块，猜不出分区就进待分区', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = seed(dir)
    const text = '# 阴影原理\n\n从光源看深度。\n\n## 偏差\n\n需要 bias。\n\n## 级联\n\n近处高分辨率。'
    const chunks = chunkText(text)
    assert.equal(chunks.length, 3)

    const plan = planIngest(db, { title: '阴影笔记', text })
    assert.equal(plan.chunks.length, 3)
    assert.equal(Array.isArray(plan.chunks[0].suggestions), true)

    const created = applyPlan(db, dir, plan)
    assert.equal(created.length, 3)
    assert.equal(created.every((c) => c.domain === '待分区'), true)

    const forced = applyPlan(db, dir, planIngest(db, { title: '强制', text: '# A\n\n内容' }), { domain: '数学' })
    assert.equal(forced[0].domain, '数学')
    db.close()
  } finally { cleanup() }
})
