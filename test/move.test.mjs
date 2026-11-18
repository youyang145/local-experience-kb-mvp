import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock, getBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile, readBlockFile } from '../src/blocks.mjs'
import { moveBlock } from '../src/edit.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome() {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-move-'))
  return dir
}

test('移动分区：写新文件、改索引、删旧文件、内容不变', () => {
  const home = tempHome()
  initHome(home)
  const db = openDb(layout(home).db)
  try {
    const block = buildCandidate({ title: '移动测试', body: '正文内容', domain: '工具/DSH' })
    const oldPath = writeBlockFile(home, block)
    upsertBlock(db, { ...block, path: oldPath })

    const result = moveBlock(db, home, block.id, '网络/HTTP')
    assert.equal(result.moved, true)
    assert.equal(fs.existsSync(oldPath), false)

    const row = getBlock(db, block.id)
    assert.equal(row.domain, '网络/HTTP')
    assert.ok(fs.existsSync(row.path))
    const file = readBlockFile(row.path)
    assert.equal(file.domain, '网络/HTTP')
    assert.match(file.body, /正文内容/)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('移动分区：只接受两级路径', () => {
  const home = tempHome()
  initHome(home)
  const db = openDb(layout(home).db)
  try {
    const block = buildCandidate({ title: '非法分区测试', body: 'x', domain: '工具/DSH' })
    const abs = writeBlockFile(home, block)
    upsertBlock(db, { ...block, path: abs })
    assert.throws(() => moveBlock(db, home, block.id, '一级'), /两级/)
    assert.throws(() => moveBlock(db, home, block.id, 'a/b/c'), /两级/)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
