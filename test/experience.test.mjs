/**
 * M1 验收：经验块的字段、五个动作、优先级、孤儿规则、冷启动往返。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock, getBlock, searchBlocks, softDelete } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile, readBlockFile, moveToTrash } from '../src/blocks.mjs'
import {
  makeExperience, applyUse, recordOccurrence, refine, merge, transplant,
  refute, vote, pin, promote, priority, experienceOf, listExperiences,
  orphanExperiences,
} from '../src/experience.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome() {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-'))
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* 句柄未释放留给下次 */ }
    },
  }
}

function setup(dir) {
  initHome(dir)
  const db = openDb(layout(dir).db)
  const knowledge = (title, domain) => {
    const block = buildCandidate({ title, body: `${title} 的正文`, domain }, { salt: title })
    const abs = writeBlockFile(dir, block)
    upsertBlock(db, { ...block, path: abs })
    return block
  }
  const experience = (claim, domain = 'default', extra = {}) => {
    const exp = makeExperience({ claim, domain, scope: '适用条件', ...extra })
    const abs = writeBlockFile(dir, exp)
    upsertBlock(db, { ...exp, path: abs })
    return exp
  }
  return { db, knowledge, experience }
}

test('优先级：4√复现 + 3成功 + 2使用 + 2补充 + 5人票', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, experience } = setup(dir)
    const exp = experience('一条用来算分的经验')
    const id = exp.id
    applyUse(db, dir, id, { result: 'success' })
    applyUse(db, dir, id, { result: 'failure' })
    recordOccurrence(db, dir, id)
    recordOccurrence(db, dir, id)
    recordOccurrence(db, dir, id)
    refine(db, dir, id, { note: '补了一条边界' })
    const { exp: got } = experienceOf(db, dir, id)
    const expected = 4 * Math.sqrt(3) + 3 * 1 + 2 * 2 + 2 * 1
    assert.ok(Math.abs(priority(got) - expected) < 0.02, `优先级 ${priority(got)} 应约等于 ${expected}`)
    assert.equal(got.accounting.used, 2)
    assert.equal(got.accounting.succeeded, 1)
    assert.equal(got.accounting.occurrences, 3)
    assert.equal(got.accounting.refined, 1)
    assert.equal(got.version, 2)
    db.close()
  } finally { cleanup() }
})

test('融合：产出新块，来源经验标 superseded_by，家随问题所在领域', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, experience } = setup(dir)
    const a = experience('数学里的方法 A', '数学')
    const b = experience('物理里的方法 B', '物理')
    const fused = merge(db, dir, a.id, b.id, { claim: 'A 和 B 合起来能解一类题', domain: '物理' })

    assert.equal(fused.kind, 'fusion')
    assert.equal(fused.domain, '物理')
    assert.equal(fused.tier, 'probation')
    assert.deepEqual(fused.lineage.fused_from, [a.id, b.id])

    const a2 = experienceOf(db, dir, a.id).exp
    const b2 = experienceOf(db, dir, b.id).exp
    assert.equal(a2.lineage.superseded_by, fused.id)
    assert.equal(b2.lineage.superseded_by, fused.id)
    db.close()
  } finally { cleanup() }
})

test('跨域派生：父不动，子在新领域、计数归零', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, experience } = setup(dir)
    const parent = experience('数学里的通用解法', '数学')
    applyUse(db, dir, parent.id, { result: 'success' })

    const child = transplant(db, dir, parent.id, { domain: '物理' })
    assert.equal(child.kind, 'transfer')
    assert.equal(child.domain, '物理')
    assert.deepEqual(child.lineage.derived_from, [parent.id])
    assert.equal(child.accounting.used, 0)
    assert.equal(child.accounting.succeeded, 0)
    assert.equal(child.tier, 'probation')

    const p2 = experienceOf(db, dir, parent.id).exp
    assert.equal(p2.domain, '数学')
    assert.equal(p2.accounting.used, 1)
    assert.deepEqual(p2.lineage.derived_from, [])
    db.close()
  } finally { cleanup() }
})

test('推翻：默认检索不出现，反例可查', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, experience } = setup(dir)
    const exp = experience('会被推翻的经验：缓存目录不能指向工作区')
    refute(db, dir, exp.id, { by: 'k261031abc123', note: '新版本已经支持' })

    assert.equal(searchBlocks(db, '缓存目录').length, 0)
    const withRefuted = searchBlocks(db, '缓存目录', { includeRefuted: true })
    assert.equal(withRefuted.length, 1)
    assert.equal(withRefuted[0].status, 'refuted')
    db.close()
  } finally { cleanup() }
})

test('转正与置顶：tier 变 main，置顶把优先级拉到最高', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, experience } = setup(dir)
    const exp = experience('一条待转正的经验', 'default', { tier: 'probation' })
    const promoted = promote(db, dir, exp.id)
    assert.equal(promoted.tier, 'main')
    assert.equal(promoted.status, 'verified')

    const pinned = pin(db, dir, exp.id, true)
    assert.ok(priority(pinned) >= 1000)
    db.close()
  } finally { cleanup() }
})

test('孤儿：删掉知识块，经验不连坐，仍留在领域里', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, knowledge, experience } = setup(dir)
    const k = knowledge('被删除的知识块', '数学')
    const exp = experience('挂在知识块上的经验', '数学', { primary_knowledge: k.id })

    moveToTrash(dir, getBlock(db, k.id).path, k.id)
    softDelete(db, k.id, new Date().toISOString())
    const marked = orphanExperiences(db, dir, k.id)
    assert.deepEqual(marked, [exp.id])

    const after = experienceOf(db, dir, exp.id).exp
    assert.equal(after.orphaned, true)
    assert.equal(after.primary_knowledge, '')
    assert.equal(after.domain, '数学')
    assert.ok(fs.existsSync(getBlock(db, exp.id).path))
    db.close()
  } finally { cleanup() }
})

test('冷启动：账与血缘从明文原样读回', () => {
  const { dir, cleanup } = tempHome()
  try {
    const { db, experience } = setup(dir)
    const exp = experience('冷启动往返测试', '化学')
    applyUse(db, dir, exp.id, { result: 'success' })
    recordOccurrence(db, dir, exp.id)
    vote(db, dir, exp.id, 1)
    db.close()

    const db2 = openDb(layout(dir).db)
    const { exp: back } = experienceOf(db2, dir, exp.id)
    assert.equal(back.domain, '化学')
    assert.equal(back.accounting.used, 1)
    assert.equal(back.accounting.succeeded, 1)
    assert.equal(back.accounting.occurrences, 1)
    assert.equal(back.accounting.human_vote, 1)
    assert.equal(back.claim, '冷启动往返测试')
    assert.equal(listExperiences(db2, dir).length, 1)
    db2.close()
  } finally { cleanup() }
})
