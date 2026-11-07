/**
 * 知识块增强（P1）：类型、标签、目录。
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
import { updateBlock } from '../src/edit.mjs'
import { parseOutline, outlineLine } from '../src/outline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome() {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-'))
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ } },
  }
}

test('目录：只认 ## 和 ###，H1 与更深层级不进目录', () => {
  const body = '# 块标题\n\n## 第一节\n\n正文\n\n### 1.1 小节\n\n#### 太深\n\n## 第二节\n'
  const outline = parseOutline(body)
  assert.deepEqual(outline.map((item) => [item.level, item.title]), [[2, '第一节'], [3, '1.1 小节'], [2, '第二节']])
  assert.equal(outline[0].line, 2)
  assert.equal(outline[0].offset, body.indexOf('## 第一节'))
  assert.equal(outlineLine(outline), '第一节 · 1.1 小节 · 第二节')
})

test('类型与标签：写入后从明文读回', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    const block = buildCandidate({
      title: '基础搜索与修改',
      body: '## 前置\n\n已授权\n\n## 步骤\n\n1. 精确搜索\n',
      domain: '工具',
      kind: 'howto',
      tags: ['GameGuardian', '搜索'],
    }, { salt: 'k' })

    const abs = writeBlockFile(dir, block)
    upsertBlock(db, { ...block, path: abs })

    const meta = readBlockFile(abs)
    assert.equal(meta.kind, 'howto')
    assert.deepEqual(meta.tags, ['GameGuardian', '搜索'])
    assert.equal(parseOutline(meta.body).length, 2)
    db.close()
  } finally { cleanup() }
})

test('编辑：可以改类型和标签，标签字符串会切成数组', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)
    const block = buildCandidate({ title: '一条知识', body: '## 定义\n\n内容\n', kind: 'concept' }, { salt: 'e' })
    const abs = writeBlockFile(dir, block)
    upsertBlock(db, { ...block, path: abs })

    updateBlock(db, dir, block.id, { kind: 'troubleshoot', tags: '排错, 搜索' })
    const meta = readBlockFile(getBlock(db, block.id).path)
    assert.equal(meta.kind, 'troubleshoot')
    assert.deepEqual(meta.tags, ['排错', '搜索'])
    db.close()
  } finally { cleanup() }
})
