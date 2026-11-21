import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile } from '../src/blocks.mjs'
import { search } from '../src/search.mjs'

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-search-'))
  initHome(dir)
  return dir
}

test('索引命中：走 index，不启动深扫', async () => {
  const home = tempHome()
  const db = openDb(layout(home).db)
  try {
    const block = buildCandidate({ title: '索引命中测试', body: '正文里有独特词 青柠索引', domain: '测试/索引' })
    upsertBlock(db, { ...block, path: writeBlockFile(home, block) })
    const result = await search(db, '青柠索引', { home, mode: 'index', profile: 'index' })
    assert.equal(result.rows.length > 0, true)
    assert.equal(result.strategies.includes('index'), true)
    assert.equal(result.deep, null)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('零命中：索引为空时，深扫把文件里的词找出来', async () => {
  const home = tempHome()
  const db = openDb(layout(home).db)
  try {
    const dir = path.join(home, 'blocks', '测试', '主题', 'knowledge', 'aa')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'deep1.md'), [
      '---',
      'id: deep1',
      'title: 深海测试',
      'summary: 文件级深扫样例',
      'domain: 测试/主题',
      'type: knowledge',
      '---',
      '',
      '正文包含 深海测试 这个词。',
    ].join('\n'), 'utf8')

    const result = await search(db, '深海测试', { home, mode: 'auto', profile: 'balanced' })
    assert.equal(result.strategies.includes('deep'), true)
    assert.equal(result.rows.some((row) => row.sources.includes('deep')), true)
    assert.equal(result.complete, true)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('文件类查询也触发深扫；关掉 allowDeep 就不触发', async () => {
  const home = tempHome()
  const db = openDb(layout(home).db)
  try {
    fs.mkdirSync(path.join(home, 'blocks', '测试'), { recursive: true })
    fs.writeFileSync(path.join(home, 'blocks', '测试', 'note.md'), '设计稿说明：附件 图片 放在这里。', 'utf8')
    const on = await search(db, '附件 图片 设计稿', { home, mode: 'auto', profile: 'quick', allowDeep: true })
    assert.equal(on.strategies.includes('deep'), true)
    const off = await search(db, '附件 图片 设计稿', { home, mode: 'auto', profile: 'quick', allowDeep: false })
    assert.equal(off.strategies.includes('deep'), false)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
