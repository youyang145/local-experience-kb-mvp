import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout } from '../src/config.mjs'
import { openDb } from '../src/db.mjs'
import { handleMcp, setMcpEnabled } from '../src/mcp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('MCP kb_deep：索引为空时，深扫文件并返回覆盖率', async () => {
  const home = fs.mkdtempSync(path.join(here, '.tmp-deep-'))
  initHome(home)
  setMcpEnabled(home, true)
  const dir = path.join(home, 'blocks', '测试', '深扫', 'knowledge', 'aa')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'deep-mcp.md'), [
    '---',
    'id: deep-mcp',
    'title: 深扫探针',
    'summary: 只写在文件里，不在索引中',
    'domain: 测试/深扫',
    'type: knowledge',
    '---',
    '',
    '正文里有独特词 深海探针。',
  ].join('\n'), 'utf8')

  const db = openDb(layout(home).db)
  try {
    const init = await handleMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'deep-test' } } },
      db,
      { home },
    )
    const sid = init.headers['Mcp-Session-Id']
    assert.ok(sid)
    assert.match(init.body.result.instructions, /kb_deep/)

    const list = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, db, { home })
    assert.ok(list.body.result.tools.some((tool) => tool.name === 'kb_deep'))

    const call = await handleMcp(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_deep', arguments: { query: '深海探针', limit: 3 } } },
      db,
      { home, sessionId: sid },
    )
    const text = call.body.result.content[0].text
    assert.match(text, /深扫探针/)
    assert.match(text, /覆盖/)
    assert.match(text, /KB_DATA 开始/)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
