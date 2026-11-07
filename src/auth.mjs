/**
 * 写接口的配对授权（本机）。
 *
 * 模型：
 * - 服务启动生成 6 位配对码，重启即换；
 * - 人在面板读取配对码，交给第三方 Agent；
 * - 第三方 `POST /api/pair` 用配对码换 token（只在内存，重启清空）；
 * - 写请求：浏览器同源面板按 Origin 放行；其他客户端必须带 `x-kb-token`；
 * - 配对与写操作都写进 `_mcp/api-auth.jsonl`，带 ISO 日期。
 *
 * 边界：本机恶意进程仍可读内存或伪造 Origin；配对挡的是跨站请求和未被授权的工具，
 * 不是本机提权。文档里要写清这一点。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MAX_FAILS = 5
const LOCK_MS = 10 * 60 * 1000
const PANEL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 常量时间比较，长度不同也安全。 */
function sameSecret(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest()
  const right = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(left, right)
}

export function createAuth(home) {
  let code = newCode()
  let failures = 0
  let lockedUntil = 0
  let tokenSeq = 0
  const tokens = new Map() // token -> { id, name, createdAt, lastUsedAt, calls }

  function audit(entry) {
    try {
      const dir = path.join(home, '_mcp')
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(
        path.join(dir, 'api-auth.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
        'utf8',
      )
    } catch { /* 留痕失败不影响主流程 */ }
  }

  function isPanelOrigin(origin) {
    return PANEL_ORIGIN.test(String(origin ?? ''))
  }

  function locked() {
    return Date.now() < lockedUntil
  }

  function verify(token) {
    const rec = tokens.get(String(token ?? ''))
    if (!rec) return null
    rec.lastUsedAt = new Date().toISOString()
    rec.calls += 1
    return rec
  }

  function pair(givenCode, { name = 'unknown' } = {}) {
    const now = Date.now()
    if (now < lockedUntil) {
      audit({ event: 'pair-denied', result: 'locked', name })
      return { ok: false, error: `尝试过多，锁定到 ${new Date(lockedUntil).toISOString()}` }
    }
    if (!sameSecret(givenCode, code)) {
      failures += 1
      audit({ event: 'pair-failed', result: 'bad-code', name, failures })
      if (failures >= MAX_FAILS) {
        lockedUntil = now + LOCK_MS
        failures = 0
        code = newCode()
        audit({ event: 'pair-locked', result: 'rotated', until: new Date(lockedUntil).toISOString() })
      }
      return { ok: false, error: '配对码不对' }
    }
    failures = 0
    tokenSeq += 1
    const token = crypto.randomBytes(24).toString('hex')
    const rec = {
      id: `T-${String(tokenSeq).padStart(3, '0')}`,
      name: String(name).slice(0, 40),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      calls: 0,
    }
    tokens.set(token, rec)
    audit({ event: 'pair-ok', result: 'ok', tokenId: rec.id, name: rec.name })
    return { ok: true, token, tokenId: rec.id, tokenName: rec.name, at: rec.createdAt }
  }

  function list() {
    return [...tokens.values()].map((rec) => ({ ...rec }))
  }

  function revoke(tokenId) {
    for (const [token, rec] of tokens.entries()) {
      if (rec.id === tokenId) {
        tokens.delete(token)
        audit({ event: 'revoke', result: 'ok', tokenId: rec.id, name: rec.name })
        return { ok: true, id: tokenId }
      }
    }
    return { ok: false, error: `没有这个 token：${tokenId}` }
  }

  function status() {
    return {
      locked: locked(),
      lockedUntil: locked() ? new Date(lockedUntil).toISOString() : null,
      tokens: list(),
    }
  }

  function codeView() {
    return { code, locked: locked(), lockedUntil: locked() ? new Date(lockedUntil).toISOString() : null }
  }

  return { audit, isPanelOrigin, verify, pair, list, revoke, status, codeView }
}
