import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAuth } from '../src/auth.mjs'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-auth-'))
}

test('配对：错码失败、对码成功并返回可验证 token', () => {
  const home = tempHome()
  const auth = createAuth(home)
  const { code } = auth.codeView()
  assert.equal(auth.pair('000000').ok, false)
  const ok = auth.pair(code, { name: 'probe' })
  assert.equal(ok.ok, true)
  assert.match(ok.token, /^[0-9a-f]{48}$/)
  const rec = auth.verify(ok.token)
  assert.equal(rec.name, 'probe')
  assert.equal(auth.verify('deadbeef'), null)
})

test('撤销后 token 立即失效', () => {
  const home = tempHome()
  const auth = createAuth(home)
  const { code } = auth.codeView()
  const { token, tokenId } = auth.pair(code, { name: 'revoke-me' })
  assert.ok(auth.verify(token))
  assert.equal(auth.revoke(tokenId).ok, true)
  assert.equal(auth.verify(token), null)
})

test('连错 5 次锁定并换码', () => {
  const home = tempHome()
  const auth = createAuth(home)
  const first = auth.codeView().code
  for (let i = 0; i < 5; i += 1) auth.pair('999999')
  const after = auth.codeView()
  assert.equal(after.locked, true)
  assert.notEqual(after.code, first)
  assert.equal(auth.pair(after.code).ok, false)
})

test('面板来源判断：本机放行，外站拒绝', () => {
  const home = tempHome()
  const auth = createAuth(home)
  assert.equal(auth.isPanelOrigin('http://127.0.0.1:7788'), true)
  assert.equal(auth.isPanelOrigin('http://localhost:7788'), true)
  assert.equal(auth.isPanelOrigin('https://evil.example'), false)
  assert.equal(auth.isPanelOrigin(''), false)
})

test('留痕带 ISO 日期', () => {
  const home = tempHome()
  const auth = createAuth(home)
  const { code } = auth.codeView()
  auth.pair(code, { name: 'audit' })
  const file = path.join(home, '_mcp', 'api-auth.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.event === 'pair-ok' && /^\d{4}-\d{2}-\d{2}T/.test(l.at)))
})
