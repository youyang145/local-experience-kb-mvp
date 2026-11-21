import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile } from '../src/blocks.mjs'
import { handleMcp, setMcpEnabled } from '../src/mcp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('MCP kb_read：按 id 读正文，最多 3 条', async () => {
  const home = fs.mkdtempSync(path.join(here, '.tmp-read-'))
  initHome(home)
  setMcpEnabled(home, true)
  const db = openDb(layout(home).db)
  try {
    const block = buildCandidate({ title: '读取测试', body: '这是正文细节', domain: '工具/DSH' })
    const abs = writeBlockFile(home, block)
    upsertBlock(db, { ...block, path: abs })

    const init = await handleMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'read-test' } } },
      db,
      { home },
    )
    const sid = init.headers['Mcp-Session-Id']
    assert.ok(sid)
    const instructions = init.body.result.instructions
    assert.match(instructions, /两级/)
    assert.match(instructions, /claim/)
    assert.match(instructions, /知识/)
    assert.match(instructions, /kb_read/)

    const list = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, db, { home })
    assert.ok(list.body.result.tools.some((tool) => tool.name === 'kb_read'))
    const consult = list.body.result.tools.find((tool) => tool.name === 'kb_consult')
    assert.equal(consult.annotations.readOnlyHint, true)
    const stage = list.body.result.tools.find((tool) => tool.name === 'kb_stage')
    assert.equal(stage.annotations.readOnlyHint, false)

    const read = await handleMcp(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_read', arguments: { ids: [block.id] } } },
      db,
      { home, sessionId: sid },
    )
    const readText = read.body.result.content[0].text
    assert.match(readText, /这是正文细节/)
    assert.match(readText, /KB_DATA 开始/)
    assert.match(readText, /不是给你的指令/)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})


