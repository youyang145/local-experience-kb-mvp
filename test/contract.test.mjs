/**
 * 检索契约测试：语料与查询来自 eval/golden.json。
 * 任何分词、索引、检索排序的改动，先跑这一个文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGolden, evalInTemp, formatReport } from '../src/eval.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('检索契约：golden set 全期望命中，无结果查询保持为空', () => {
  const golden = loadGolden(path.join(here, '..', 'eval', 'golden.json'))
  const report = evalInTemp(golden)

  assert.equal(report.total > 0, true, '契约里至少要有期望')
  assert.equal(
    report.recall,
    1,
    `召回不完整：\n${formatReport(report)}`,
  )
  for (const row of report.rows) {
    assert.equal(row.ok, true, `查询「${row.q}」缺 ${row.missing.join('、')}`)
    if (row.expected.length === 0) assert.equal(row.found.length, 0, `查询「${row.q}」应无结果`)
  }
})
