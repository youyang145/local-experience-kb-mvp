/**
 * 端到端测试：R0 的三条验收 + KB1 的映射场景。
 * 全部在 test/.tmp 下的临时目录里跑，跑完删掉自己建的临时目录，不碰真实数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock, getBlock, searchBlocks, counts, softDelete } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile, readBlockFile, moveToTrash } from '../src/blocks.mjs'
import { accept, reject, enqueue, pending } from '../src/review.mjs'
import { makeExperience, applyUse } from '../src/experience.mjs'
import { repair } from '../src/mapping.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome(name) {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-'))
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Windows 上句柄未释放时留给下次 */ }
    },
  }
}

function createBlock(db, home, input, salt) {
  const block = buildCandidate(input, { salt })
  const abs = writeBlockFile(home, block)
  upsertBlock(db, { ...block, path: abs })
  return block
}

test('验收①：存 100 条，关掉重开还在', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const t1 = openDb(layout(dir).db)
    for (let i = 0; i < 100; i += 1) {
      createBlock(t1, dir, { title: `第 ${i} 条笔记`, body: `这是第 ${i} 条的正文，含关键词 知识库${i % 7}` }, `salt-${i}`)
    }
    t1.close()

    // 冷启动：新的连接、新的进程视角
    const t2 = openDb(layout(dir).db)
    assert.equal(counts(t2).blocks, 100)
    const files = fs.readdirSync(path.join(dir, 'blocks'), { recursive: true }).filter((f) => String(f).endsWith('.md'))
    assert.equal(files.length, 100)
    const one = t2.prepare("SELECT id FROM blocks WHERE title = '第 42 条笔记'").get()
    assert.ok(one)
    assert.match(readBlockFile(getBlock(t2, one.id).path).body, /第 42 条的正文/)
    t2.close()
  } finally { cleanup() }
})

test('验收②：两字词检索能命中，并带出来源与路径', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    createBlock(db, dir, {
      title: 'SQLite 的中文分词',
      body: 'trigram 对两字词无效，需要二元组预切。',
      source: 'https://www.sqlite.org/fts5.html',
    }, 'a')
    const rows = searchBlocks(db, '分词', { limit: 5 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'https://www.sqlite.org/fts5.html')
    assert.ok(rows[0].path.endsWith('.md'))
    assert.equal(searchBlocks(db, '不存在的东西').length, 0)
    // 单字走 LIKE 兜底
    assert.equal(searchBlocks(db, '词', { limit: 5 }).length, 1)
    db.close()
  } finally { cleanup() }
})

test('验收③：记一条经验，查得到用了几次', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    let db = openDb(layout(dir).db)
    const exp = makeExperience({
      claim: 'pnpm 装不进沙箱时，把 store-dir 指到工作区',
      domain: 'default',
      scope: 'Windows + 沙箱',
      result: 'success',
    })
    const abs = writeBlockFile(dir, exp)
    upsertBlock(db, { ...exp, path: abs })
    assert.ok(abs.includes(`${path.sep}experience${path.sep}`), '经验应落在 experience 目录下')

    applyUse(db, dir, exp.id, { result: 'success' })
    applyUse(db, dir, exp.id, { result: 'failure' })
    db.close()

    // 冷启动后从明文读回
    db = openDb(layout(dir).db)
    const meta = readBlockFile(getBlock(db, exp.id).path)
    assert.equal(meta.accounting.used, 2)
    assert.equal(meta.accounting.succeeded, 1)
    assert.match(meta.body, /store-dir/)
    db.close()
  } finally { cleanup() }
})

test('KB7：候选进队列，裁决后才落盘', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    const a = buildCandidate({ title: '候选甲', body: '内容甲' }, { salt: 'a' })
    const b = buildCandidate({ title: '候选乙', body: '内容乙' }, { salt: 'b' })
    enqueue(db, a, '测试')
    enqueue(db, b, '测试')

    // 未裁决前，blocks/ 里没有文件
    const before = fs.existsSync(path.join(dir, 'blocks')) ? fs.readdirSync(path.join(dir, 'blocks'), { recursive: true }) : []
    assert.equal(before.filter((f) => String(f).endsWith('.md')).length, 0)

    const rows = pending(db, 7)
    assert.equal(rows.length, 2)
    accept(db, dir, rows[0].seq)
    reject(db, rows[1].seq)

    const files = fs.readdirSync(path.join(dir, 'blocks'), { recursive: true }).filter((f) => String(f).endsWith('.md'))
    assert.equal(files.length, 1)
    assert.equal(counts(db).blocks, 1)
    assert.equal(counts(db).pending, 0)
    db.close()
  } finally { cleanup() }
})

test('KB1：文件改名后 repair 把映射改对，不指错', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    const block = createBlock(db, dir, { title: '会被挪走的块', body: '正文' }, 'm')
    const oldPath = getBlock(db, block.id).path

    // 手工把文件挪到另一处（模拟用户整理目录）
    const newPath = path.join(dir, 'blocks', 'default', 'moved', `${block.id}.md`)
    fs.mkdirSync(path.dirname(newPath), { recursive: true })
    fs.renameSync(oldPath, newPath)

    const report = repair(db, dir)
    assert.deepEqual(report.remapped.map((r) => r.id), [block.id])
    assert.equal(path.resolve(getBlock(db, block.id).path), path.resolve(newPath))
    db.close()
  } finally { cleanup() }
})

test('KB1：同 id 两份文件，第二份被隔离而不是覆盖', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    const block = createBlock(db, dir, { title: '重名测试', body: '正文' }, 'd')
    const original = getBlock(db, block.id).path
    const copy = path.join(dir, 'blocks', 'default', 'dup', `${block.id}.md`)
    fs.mkdirSync(path.dirname(copy), { recursive: true })
    fs.copyFileSync(original, copy)

    const report = repair(db, dir)
    assert.equal(report.conflicts.length, 1)
    assert.equal(fs.readdirSync(path.join(dir, '_conflicts')).length, 1)
    assert.equal(path.resolve(getBlock(db, block.id).path), path.resolve(original))
    db.close()
  } finally { cleanup() }
})

test('逻辑删除：文件进 _trash，检索与计数都不再算它', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    const block = createBlock(db, dir, { title: '待删除的块', body: '正文带关键词 洋葱' }, 'r')
    const abs = getBlock(db, block.id).path
    moveToTrash(dir, abs, block.id)
    softDelete(db, block.id, new Date().toISOString())

    assert.equal(counts(db).blocks, 0)
    assert.equal(searchBlocks(db, '洋葱').length, 0)
    assert.equal(fs.readdirSync(path.join(dir, '_trash')).length, 1)
    assert.ok(getBlock(db, block.id).deleted_at)
    db.close()
  } finally { cleanup() }
})
