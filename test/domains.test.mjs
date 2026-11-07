/**
 * 两级分区（D-034）：
 *   - domain 支持「分区/主题」，落盘路径跟着分层；
 *   - 过滤按前缀命中（选「工具」能看到「工具/GG修改器」）；
 *   - 不填领域进「待分区」，不再有 default 垃圾桶。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock, listBlocks } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile, blockFilePath } from '../src/blocks.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempHome() {
  const dir = fs.mkdtempSync(path.join(here, '.tmp-'))
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ } },
  }
}

test('分区路径：两级落盘，前缀可查，空领域进待分区', () => {
  const { dir, cleanup } = tempHome()
  try {
    initHome(dir)
    const db = openDb(layout(dir).db)

    const gg = buildCandidate({ title: 'GG 搜索流程', body: '先选进程再搜索。', domain: '工具/GG修改器' }, { salt: 'gg' })
    const ggPath = writeBlockFile(dir, gg)
    assert.equal(ggPath.includes(path.join('工具', 'GG修改器')), true)
    upsertBlock(db, { ...gg, path: ggPath })

    const tool = buildCandidate({ title: 'pnpm store', body: '装不上时改 store-dir。', domain: '工具' }, { salt: 'pnpm' })
    upsertBlock(db, { ...tool, path: writeBlockFile(dir, tool) })

    const inbox = buildCandidate({ title: '还没分区的材料', body: '先放收件箱。' }, { salt: 'inbox' })
    assert.equal(inbox.domain, '待分区')
    upsertBlock(db, { ...inbox, path: writeBlockFile(dir, inbox) })

    assert.equal(listBlocks(db, { domain: '工具' }).length, 2, '前缀应同时命中工具和工具/GG修改器')
    assert.equal(listBlocks(db, { domain: '工具/GG修改器' }).length, 1)
    assert.equal(listBlocks(db, { domain: '待分区' }).length, 1)

    assert.throws(() => blockFilePath(dir, { ...gg, domain: '工具/../逃逸' }), /不合法/)
    db.close()
  } finally { cleanup() }
})
