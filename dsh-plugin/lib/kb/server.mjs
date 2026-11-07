/**
 * 本地界面服务（只监听 127.0.0.1）。
 *
 * 这是"面板"的半身：浏览器打开就是一个长方形窗口。
 * 以后要包成 DSH 客户端插件（小鲸鱼那样的悬浮图标），前端这套代码可以直接复用，
 * 只需换掉数据来源（fetch 换成宿主提供的桥）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initHome, layout, kbHome } from './config.mjs'
import { openDb, listBlocks, searchBlocks, getBlock, counts, orphans, upsertBlock } from './db.mjs'
import { readBlockFile, writeBlockFile } from './blocks.mjs'
import { buildCandidate } from './capture.mjs'
import {
  listExperiences, applyUse, recordOccurrence, refine, vote, pin, promote,
  refute, merge, transplant, priority, explain, normalizeExp, makeExperience,
} from './experience.mjs'
import { updateBlock, removeBlock } from './edit.mjs'
import { loadSettings, saveSettings } from './settings.mjs'
import { listProposals, decide, probationItems } from './proposals.mjs'
import { softSearch } from './consult.mjs'
import { searchWithWarnings, warningsForApply } from './warnings.mjs'
import { handleMcp, mcpInfo, setMcpEnabled } from './mcp.mjs'
import { createBackup, listBackups, restoreBackup } from './backup.mjs'
import { parseOutline } from './outline.mjs'
import { repair } from './mapping.mjs'
import { pending, pendingCount } from './review.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.join(here, '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson(req) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > 2_000_000) throw new Error('请求太大')
  }
  if (!data) return {}
  return JSON.parse(data)
}

function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const abs = path.join(webDir, file)
  if (!abs.startsWith(webDir)) { res.writeHead(403).end('forbidden'); return true }
  if (!fs.existsSync(abs)) return false
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(abs).pipe(res)
  return true
}

function blockView(row, home, withBody) {
  const meta = readBlockFile(row.path)
  const view = {
    id: row.id,
    type: row.type,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    source: row.source,
    domain: row.domain,
    status: row.status,
    tier: row.tier,
    orphaned: Boolean(row.orphaned),
    primary_knowledge: row.primary_knowledge,
    created_at: row.created_at,
    modified_at: row.modified_at,
    version: row.version,
    editor: row.editor,
    path: row.path,
  }
  if (withBody) view.body = meta.body ?? ''
  if (row.type === 'knowledge') {
    view.tags = meta.tags ?? []
    if (withBody) view.outline = parseOutline(meta.body)
  }
  if (row.type === 'experience') {
    const exp = normalizeExp(meta)
    view.claim = exp.claim
    view.scope = exp.scope
    view.limits = exp.limits
    view.lineage = exp.lineage
    view.accounting = exp.accounting
    view.evidence = exp.evidence ?? []
    view.priority = priority(exp)
    view.why = explain(exp)
  }
  return view
}

export function createHandler({ home }) {
  initHome(home)
  let db = openDb(layout(home).db)
  const reopenDb = () => { db = openDb(layout(home).db) }

  return async function handler(req, res) {
    // 只允许本机来源跨端口访问 /api（面板被 DSH 页面里的挂件 iframe/fetch 调用）
    const origin = req.headers.origin || ''
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)

    // MCP：其他 Agent 用 JSON-RPC 连上来查库（只读）
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let rpc
      try {
        rpc = await readJson(req)
      } catch {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
        return
      }
      const result = await handleMcp(rpc, db, { home, sessionId: req.headers['mcp-session-id'] })
      if (result.status === 202) {
        res.writeHead(202)
        res.end()
        return
      }
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(result.headers ?? {}) })
      res.end(JSON.stringify(result.body))
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      if (serveStatic(res, url.pathname)) return
      json(res, 404, { ok: false, error: 'not found' })
      return
    }

    try {
      // GET /api/mcp-info：面板展示 MCP 端点信息
      if (req.method === 'GET' && url.pathname === '/api/mcp-info') {
        json(res, 200, { ok: true, data: mcpInfo(home) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/backup') {
        const body = await readJson(req).catch(() => ({}))
        const result = createBackup(home, {
          includeTrash: body.includeTrash !== false,
          includeIndex: body.includeIndex !== false,
          keep: Number(body.keep ?? 0),
        })
        json(res, 200, { ok: true, data: result })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/restore') {
        const body = await readJson(req)
        const name = path.basename(String(body.name ?? ''))
        if (!name.endsWith('.zip')) { json(res, 400, { ok: false, error: '备份名不合法' }); return }
        const target = path.join(home, '_backup', name)
        if (!fs.existsSync(target)) { json(res, 404, { ok: false, error: '找不到这个备份' }); return }
        const mode = body.mode === 'merge' ? 'merge' : 'overwrite'
        let result
        try {
          db.close()
          result = restoreBackup(home, target, { mode })
        } finally {
          reopenDb()
        }
        json(res, 200, { ok: true, data: result })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/backups') {
        json(res, 200, { ok: true, data: listBackups(home) })
        return
      }
      if (req.method === 'POST' && (url.pathname === '/api/mcp/enable' || url.pathname === '/api/mcp/disable')) {
        const enabled = url.pathname.endsWith('/enable')
        setMcpEnabled(home, enabled)
        json(res, 200, { ok: true, data: mcpInfo(home) })
        return
      }

      // GET /api/overview
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const c = counts(db)
        const domains = db.prepare(`SELECT domain, count(*) AS n FROM blocks
          WHERE deleted_at IS NULL GROUP BY domain ORDER BY n DESC`).all()
        // 两级分区树（D-034）：domain 形如「分区/主题」
        const byTop = new Map()
        for (const { domain, n } of domains) {
          const segs = String(domain).split('/')
          const top = segs[0]
          if (!byTop.has(top)) byTop.set(top, { name: top, path: top, count: 0, children: [] })
          const node = byTop.get(top)
          node.count += n
          if (segs.length > 1) {
            const childPath = segs.slice(0, 2).join('/')
            let child = node.children.find((c) => c.path === childPath)
            if (!child) { child = { name: segs[1], path: childPath, count: 0 }; node.children.push(child) }
            child.count += n
          }
        }
        const tree = [...byTop.values()]
          .map((node) => ({ ...node, children: node.children.sort((a, b) => b.count - a.count) }))
          .sort((a, b) => b.count - a.count)
        json(res, 200, {
          ok: true,
          data: {
            stats: c,
            domains,
            tree,
            settings: loadSettings(home).experience,
            home,
            orphans: orphans(db).length,
            proposals: pendingCount(db),
          },
        })
        return
      }

      // POST /api/blocks —— 新建知识块
      if (req.method === 'POST' && url.pathname === '/api/blocks') {
        const body = await readJson(req)
        if (!body.title) throw new Error('标题必填')
        const block = buildCandidate({
          title: body.title,
          body: body.body ?? '',
          summary: body.summary ?? '',
          source: body.source ?? '',
          domain: body.domain ?? '待分区',
          kind: body.kind ?? 'concept',
          tags: body.tags ?? '',
        })
        const abs = writeBlockFile(home, block)
        upsertBlock(db, { ...block, path: abs })
        json(res, 200, { ok: true, data: { id: block.id } })
        return
      }

      // POST /api/experiences —— 手动记一条经验
      if (req.method === 'POST' && url.pathname === '/api/experiences') {
        const body = await readJson(req)
        const exp = makeExperience({
          claim: body.claim,
          domain: body.domain ?? '待分区',
          scope: body.scope ?? '',
          limits: body.limits ?? '',
        })
        const abs = writeBlockFile(home, exp)
        upsertBlock(db, { ...exp, path: abs })
        json(res, 200, { ok: true, data: { id: exp.id, claim: exp.claim } })
        return
      }

      // GET /api/search?q= —— 检索 + 反例警示
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const q = url.searchParams.get('q') ?? ''
        const limit = Number(url.searchParams.get('limit') ?? 20)
        if (!q.trim()) { json(res, 200, { ok: true, data: { rows: [], warnings: [] } }); return }
        const result = searchWithWarnings(db, q, { limit })
        json(res, 200, { ok: true, data: result })
        return
      }

      // GET /api/blocks?q=&type=&domain=
      if (req.method === 'GET' && url.pathname === '/api/blocks') {
        const q = url.searchParams.get('q') ?? ''
        const type = url.searchParams.get('type') ?? undefined
        const domain = url.searchParams.get('domain') ?? undefined
        const limit = Number(url.searchParams.get('limit') ?? 50)
        let rows = q
          ? searchBlocks(db, q, { limit, includeRefuted: url.searchParams.get('refuted') === '1' })
          : listBlocks(db, { limit, type, domain })
        // 整句不命中时拆词兜底（和 consult 一致）
        if (q && !rows.length) rows = softSearch(db, q, limit)
        json(res, 200, { ok: true, data: rows.map((r) => ({ ...r, orphaned: Boolean(r.orphaned) })) })
        return
      }

      // /api/blocks/:id
      if (parts[1] === 'blocks' && parts[2]) {
        const id = decodeURIComponent(parts[2])
        if (req.method === 'GET') {
          const row = getBlock(db, id)
          if (!row) { json(res, 404, { ok: false, error: '找不到' }); return }
          json(res, 200, { ok: true, data: blockView(row, home, true) })
          return
        }
        if (req.method === 'PATCH') {
          const patch = await readJson(req)
          const meta = updateBlock(db, home, id, patch)
          const row = getBlock(db, id)
          json(res, 200, { ok: true, data: blockView(row, home, true), version: meta.version })
          return
        }
        if (req.method === 'DELETE') {
          const result = removeBlock(db, home, id)
          json(res, 200, { ok: true, data: result })
          return
        }
      }

      // GET /api/experiences
      if (req.method === 'GET' && url.pathname === '/api/experiences') {
        const all = url.searchParams.get('all') === '1'
        const list = listExperiences(db, home, { includeRefuted: all, limit: 200 })
          .map((e) => ({
            id: e.id, claim: e.claim, domain: e.domain, kind: e.kind, tier: e.tier,
            status: e.status, priority: e.priority, why: explain(e), accounting: e.accounting,
            lineage: e.lineage, orphaned: e.orphaned, scope: e.scope, limits: e.limits,
          }))
        json(res, 200, { ok: true, data: list })
        return
      }

      // POST /api/experiences/:id/action
      if (req.method === 'POST' && parts[1] === 'experiences' && parts[2] && parts[3] === 'action') {
        const id = decodeURIComponent(parts[2])
        const body = await readJson(req)
        const action = body.action
        // 套用前先把反例捞出来（D-031：警示只在要踩坑的那一刻亮）
        const warnings = action === 'apply' ? warningsForApply(db, id) : []
        let exp
        switch (action) {
          case 'apply': exp = applyUse(db, home, id, { result: body.result ?? 'unknown', method: 'human' }); break
          case 'hit': exp = recordOccurrence(db, home, id, { note: body.note ?? '' }); break
          case 'refine': exp = refine(db, home, id, { note: body.note ?? '' }); break
          case 'vote': exp = vote(db, home, id, Number(body.value)); break
          case 'pin': exp = pin(db, home, id, body.on !== false); break
          case 'promote': exp = promote(db, home, id); break
          case 'refute': exp = refute(db, home, id, { by: body.by ?? '', note: body.note ?? '' }); break
          default: throw new Error(`未知动作：${action}`)
        }
        const row = getBlock(db, id)
        json(res, 200, { ok: true, data: blockView(row, home, true), priority: priority(normalizeExp(exp)), warnings })
        return
      }

      // POST /api/merge
      if (req.method === 'POST' && url.pathname === '/api/merge') {
        const body = await readJson(req)
        const exp = merge(db, home, body.a, body.b, { claim: body.claim, scope: body.scope ?? '', domain: body.domain })
        json(res, 200, { ok: true, data: { id: exp.id, claim: exp.claim, domain: exp.domain } })
        return
      }

      // POST /api/transplant
      if (req.method === 'POST' && url.pathname === '/api/transplant') {
        const body = await readJson(req)
        const exp = transplant(db, home, body.id, { domain: body.domain, claim: body.claim })
        json(res, 200, { ok: true, data: { id: exp.id, claim: exp.claim, domain: exp.domain } })
        return
      }

      // GET /api/proposals
      if (req.method === 'GET' && url.pathname === '/api/proposals') {
        const rows = listProposals(db, { status: url.searchParams.get('status') ?? 'pending', limit: 50 })
        json(res, 200, { ok: true, data: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) })
        return
      }

      // POST /api/proposals/:seq/decide
      if (req.method === 'POST' && parts[1] === 'proposals' && parts[2] && parts[3] === 'decide') {
        const body = await readJson(req)
        const result = decide(db, home, Number(parts[2]), {
          yes: Boolean(body.yes), note: body.note ?? '', claim: body.claim,
        })
        json(res, 200, { ok: true, data: result })
        return
      }

      // GET /api/probation
      if (req.method === 'GET' && url.pathname === '/api/probation') {
        json(res, 200, { ok: true, data: probationItems(db).map((e) => ({
          id: e.id, claim: e.claim, domain: e.domain, priority: priority(e), why: explain(e),
        })) })
        return
      }

      // /api/settings
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') {
          json(res, 200, { ok: true, data: loadSettings(home).experience })
          return
        }
        if (req.method === 'POST') {
          const body = await readJson(req)
          const settings = saveSettings(home, { experience: body.experience ?? body })
          json(res, 200, { ok: true, data: settings.experience })
          return
        }
      }

      // POST /api/repair
      if (req.method === 'POST' && url.pathname === '/api/repair') {
        const report = repair(db, home)
        json(res, 200, { ok: true, data: report })
        return
      }

      // GET /api/candidates
      if (req.method === 'GET' && url.pathname === '/api/candidates') {
        json(res, 200, { ok: true, data: pending(db, 20), pending: pendingCount(db) })
        return
      }

      json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      json(res, 400, { ok: false, error: error.message })
    }
  }
}

export function startServer({ home = kbHome(), port = 7788, host = '127.0.0.1' } = {}) {
  const handler = createHandler({ home })
  const server = http.createServer(handler)
  server.listen(port, host)
  const url = `http://${host}:${port}`
  return { server, url, home }
}







