/**
 * M2 验收：三档模式、提议卡、拍板留档、小经验区通知。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, getBlock, counts } from '../src/db.mjs'
import { submit, listProposals, decide, probationItems, card } from '../src/proposals.mjs'
import { saveSettings, loadSettings } from '../src/settings.mjs'
import { makeExperience } from '../src/experience.mjs'
import { writeBlockFile } from '../src/blocks.mjs'
import { upsertBlock } from '../src/db.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome() {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-'))
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ }
    },
  }
}

function setup(dir) {
  initHome(dir)
  return openDb(layout(dir).db)
}

test('审核模式：提议先排队，不落盘；拍板后才进主库', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = setup(dir)
    const res = submit(db, dir, {
      action: 'new',
      payload: { claim: '把 store-dir 指到工作区能绕过沙箱', domain: 'default', scope: 'Windows' },
      reason: '这次踩到了，而且大概率还会踩',
    })
    assert.equal(res.status, 'pending')
    assert.equal(counts(db).blocks, 0)
    assert.equal(listProposals(db).length, 1)
    assert.match(card(listProposals(db)[0], 1), /提议新建经验/)

    const done = decide(db, dir, res.seq, { yes: true })
    assert.equal(done.status, 'accepted')
    const row = getBlock(db, done.id)
    assert.ok(row)
    assert.equal(row.tier, 'main')
    assert.equal(row.status, 'verified')
    assert.equal(row.editor, 'human')
    db.close()
  } finally { cleanup() }
})

test('审核模式：否决留档，不生成块', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = setup(dir)
    const res = submit(db, dir, { action: 'new', payload: { claim: '一条没什么用的经验' } })
    decide(db, dir, res.seq, { yes: false, note: '太琐碎' })
    assert.equal(counts(db).blocks, 0)
    const row = db.prepare('SELECT status, decision_note FROM proposals WHERE seq = ?').get(res.seq)
    assert.equal(row.status, 'rejected')
    assert.equal(row.decision_note, '太琐碎')
    db.close()
  } finally { cleanup() }
})

test('审核模式：同主题冷却，第二次不打扰', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = setup(dir)
    const payload = { claim: '同一个判断' }
    assert.equal(submit(db, dir, { action: 'new', payload }).status, 'pending')
    const second = submit(db, dir, { action: 'new', payload })
    assert.equal(second.status, 'skipped')
    assert.match(second.reason, /冷却/)
    db.close()
  } finally { cleanup() }
})

test('免审模式：直接进小经验区，并给出通知', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = setup(dir)
    saveSettings(dir, { experience: { mode: 'auto', auto: { notifyEvery: 1 } } })
    const res = submit(db, dir, {
      action: 'new',
      payload: { claim: '免审模式下自动收的一条经验', domain: 'default' },
      reason: '看起来值得留',
    })
    assert.equal(res.status, 'applied')
    assert.equal(res.notify.notify, true)
    const row = getBlock(db, res.id)
    assert.equal(row.tier, 'probation')
    assert.equal(row.status, 'candidate')
    assert.equal(probationItems(db).length, 1)
    db.close()
  } finally { cleanup() }
})

test('关闭模式：不生成，也不排队', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = setup(dir)
    saveSettings(dir, { experience: { mode: 'off' } })
    const res = submit(db, dir, { action: 'new', payload: { claim: '不该被写进来的经验' } })
    assert.equal(res.status, 'off')
    assert.equal(counts(db).blocks, 0)
    assert.equal(listProposals(db).length, 0)
    db.close()
  } finally { cleanup() }
})

test('推翻提议：即使免审模式也必须人审', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = setup(dir)
    saveSettings(dir, { experience: { mode: 'auto' } })
    const exp = makeExperience({ claim: '一条会被推翻的经验', domain: 'default' })
    const abs = writeBlockFile(dir, exp)
    upsertBlock(db, { ...exp, path: abs })

    const res = submit(db, dir, { action: 'refute', payload: { id: exp.id, by: 'k1', note: '有反例' } })
    assert.equal(res.status, 'pending')
    // 拍板前，经验仍然是候选状态
    assert.equal(getBlock(db, exp.id).status, 'candidate')
    decide(db, dir, res.seq, { yes: true })
    assert.equal(getBlock(db, exp.id).status, 'refuted')
    db.close()
  } finally { cleanup() }
})

test('融合提议：接受后产出 fusion 并转正', () => {
  const { dir, cleanup } = tempHome()
  try {
    const db = setup(dir)
    const mk = (claim) => {
      const exp = makeExperience({ claim, domain: '数学' })
      const abs = writeBlockFile(dir, exp)
      upsertBlock(db, { ...exp, path: abs })
      return exp
    }
    const a = mk('方法 A')
    const b = mk('方法 B')
    const res = submit(db, dir, {
      action: 'merge',
      payload: { a: a.id, b: b.id, claim: 'A 和 B 其实是同一招', domain: '物理' },
      reason: '两条经验在同一个问题上重合',
    })
    assert.equal(res.status, 'pending')
    const done = decide(db, dir, res.seq, { yes: true, claim: 'A 和 B 是同一招（人改写）' })
    const row = getBlock(db, done.id)
    assert.equal(row.kind, 'fusion')
    assert.equal(row.domain, '物理')
    assert.equal(row.tier, 'main')
    assert.equal(row.status, 'verified')
    db.close()
  } finally { cleanup() }
})

test('设置读写：模式可切换且落盘', () => {
  const { dir, cleanup } = tempHome()
  try {
    setup(dir).close()
    saveSettings(dir, { experience: { mode: 'auto' } })
    assert.equal(loadSettings(dir).experience.mode, 'auto')
    assert.equal(loadSettings(dir).experience.auto.notifyEvery, 10)
  } finally { cleanup() }
})
