/**
 * 检索警示测试（D-031 触发时机）：
 *   - 单字/单词查询不弹；
 *   - 多词且高度相似才弹；
 *   - 套用某条经验时，才提示它的反例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { makeExperience, refute } from '../src/experience.mjs'
import { writeBlockFile } from '../src/blocks.mjs'
import { findWarnings, searchWithWarnings, warningsForApply, queryTerms } from '../src/warnings.mjs'

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
  const knowledge = buildCandidate({
    title: 'SQLite 全文检索方案',
    body: '用二元组分词，查询走短语匹配。',
    domain: '数据库',
  }, { salt: 'k' })
  const kAbs = writeBlockFile(dir, knowledge)
  upsertBlock(db, { ...knowledge, path: kAbs })

  const exp = makeExperience({
    claim: '两字词用 LIKE 兜底就够了',
    domain: '数据库',
    scope: '全文检索 两字词',
    body: '两字词直接 LIKE 全表扫，不用分词也能搜。',
  })
  const eAbs = writeBlockFile(dir, exp)
  upsertBlock(db, { ...exp, path: eAbs })
  refute(db, dir, exp.id, { by: 'k1', note: '十万条时太慢' })

  const sibling = makeExperience({
    claim: '两字词 LIKE 兜底方案',
    domain: '数据库',
    scope: '全文检索',
    body: '先 LIKE 兜底，不行再上索引。',
  })
  const sAbs = writeBlockFile(dir, sibling)
  upsertBlock(db, { ...sibling, path: sAbs })
  return { db, exp, sibling }
}

test('切词：汉字二元组、拉丁整词', () => {
  assert.deepEqual(queryTerms('两字词'), ['两字', '字词'])
  assert.deepEqual(queryTerms('pnpm store'), ['pnpm', 'store'])
})

test('单词查询不弹反例；多词且高度相似才弹', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db } = seed(dir)
    assert.equal(findWarnings(db, '分词').length, 0, '单词查询不该弹')

    const hit = findWarnings(db, '两字词 LIKE 全表扫')
    assert.equal(hit.length, 1)
    assert.deepEqual(hit[0].refuted_by, ['k1'])

    const { rows, warnings } = searchWithWarnings(db, '分词')
    assert.equal(rows.length > 0, true)
    assert.equal(warnings.length, 0, '默认搜索不该带警示')
    db.close()
  } finally { cleanup() }
})

test('套用前提示这条经验的反例', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, sibling } = seed(dir)
    const warnings = warningsForApply(db, sibling.id)
    assert.equal(warnings.length, 1)
    assert.deepEqual(warnings[0].refuted_by, ['k1'])
    db.close()
  } finally { cleanup() }
})
