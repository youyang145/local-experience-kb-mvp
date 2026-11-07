/**
 * 整理员（算法版）测试：抽取摘要、变更检测、重复/关联、只补空摘要、状态去重。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock, getBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile, readBlockFile } from '../src/blocks.mjs'
import { extractSummary, scanTidy, applySummaries, tidy } from '../src/tidy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome() {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-'))
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ } },
  }
}

function put(db, home, input, salt, patch = {}) {
  const block = { ...buildCandidate(input, { salt }), ...patch }
  const abs = writeBlockFile(home, block)
  upsertBlock(db, { ...block, path: abs })
  return block
}

test('抽取摘要：去掉 Markdown，取第一句，超长截断', () => {
  // 第一句太短（<24 字）时会再带一句，避免摘要只有半截
  assert.equal(extractSummary('# 标题\n\n这是第一句。这是第二句。'), '这是第一句。这是第二句。')
  assert.equal(extractSummary('```js\ncode\n```\n\n真正的正文在这里，应该被抽出来。'), '真正的正文在这里，应该被抽出来。')
  const long = extractSummary('很长的句子'.repeat(40), { max: 20 })
  assert.ok(long.length <= 21)
  assert.ok(long.endsWith('…'))
})

test('扫描：认出新变更、缺摘要、疑似重复', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    put(db, dir, { title: 'SQLite 分词方案', body: '用二元组分词，查询走短语匹配，索引可重建。', domain: '数据库' }, 'a')
    put(db, dir, { title: '缺摘要的块', body: '这条没有写简介，应该被标出来。', domain: '工程' }, 'b', { summary: '' })
    put(db, dir, { title: 'SQLite 分词方案（副本）', body: '用二元组分词，查询走短语匹配，索引可重建。', domain: '数据库' }, 'c')
    put(db, dir, { title: '完全不相关', body: '今天天气不错，适合散步。', domain: '生活' }, 'd')

    const report = scanTidy(db, dir, { state: { blocks: {} } })
    assert.equal(report.totals.blocks, 4)
    assert.equal(report.totals.changed, 4)
    assert.equal(report.totals.missingSummary, 1)
    assert.ok(report.duplicates.length >= 1, '应识别出重复组')
    assert.ok(report.duplicates[0].size >= 2)
    assert.ok(report.tasks.some((t) => t.type === 'summary'))
    assert.ok(report.tasks.some((t) => t.type === 'duplicate_group'))
    db.close()
  } finally { cleanup() }
})

test('apply：只补空简介，不改已有简介，标算法编辑', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    const withSummary = put(db, dir, { title: '已有简介', body: '正文一。正文二。', domain: '工程', summary: '人工写的简介' }, 'x')
    const noSummary = put(db, dir, { title: '没有简介', body: '这条会被补上摘要。', domain: '工程' }, 'y', { summary: '' })

    const report = scanTidy(db, dir, { state: { blocks: {} } })
    const applied = applySummaries(db, dir, report)
    assert.deepEqual(applied, [noSummary.id])

    const kept = readBlockFile(getBlock(db, withSummary.id).path)
    assert.equal(kept.summary, '人工写的简介')
    assert.equal(kept.editor, 'local')

    const filled = readBlockFile(getBlock(db, noSummary.id).path)
    assert.match(filled.summary, /这条会被补上摘要/)
    assert.equal(filled.editor, 'algorithm')
    assert.equal(filled.version, 2)
    db.close()
  } finally { cleanup() }
})

test('跑过一次后，没再改的块不再报变更', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    put(db, dir, { title: '稳定的块', body: '内容不变。', domain: '工程' }, 's')
    const first = tidy(db, dir, { apply: false })
    assert.equal(first.totals.changed, 1)
    const second = tidy(db, dir, { apply: false })
    assert.equal(second.totals.changed, 0)
    assert.equal(second.totals.tasks, 0)
    db.close()
  } finally { cleanup() }
})
