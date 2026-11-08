/**
 * 最小可用 MCP 端点（读 + 受限写 + 连接编号 + 操作留痕）。
 *
 * 对应手稿 ⑤ / ⑭：
 * - 其他 Agent 连上来查库，只监听本机；
 * - initialize 时领取连接编号（E-001…），登记它上报的 clientInfo；
 * - 每次调用记一条 activity.jsonl，便于追溯是谁查的；
 * - 写只到「待分区」收件箱与「待拍板」队列，主库仍由人审。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { consult, indexSummary } from './consult.mjs'
import { planIngest, applyPlan } from './ingest.mjs'
import { submit } from './proposals.mjs'
import { counts } from './db.mjs'

const PROTOCOL = '2024-11-05'
const SPEC_VERSION = '1.0'
/** 向上找最近的 package.json：src 和插件 lib/kb 的层级不同，不能写死。 */
function packageVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(dir, 'package.json')
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).version
    dir = path.dirname(dir)
  }
  return '0.0.0'
}
const SERVER = { name: 'local-experience-kb', version: packageVersion() }
const WRITE_SCOPE = '只写「待分区」收件箱与「待拍板」队列，不写主库'

const sessions = new Map()
let editorSeq = null

/** 从历史留痕里续上最大编号，避免重启后 E-001 重复。 */
function loadEditorSeq(home) {
  let max = 0
  try {
    const file = path.join(home, '_mcp', 'activity.jsonl')
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /"editor":"E-(\d+)"/.exec(line)
      if (match) max = Math.max(max, Number(match[1]))
    }
  } catch { /* 首次运行没有留痕，从 0 起 */ }
  return max
}

const TOOLS = [
  {
    name: 'kb_consult',
    description: '查本地知识库：先判要不要查，再给索引摘要与命中（简介，不含全文）。用于技术问题、排错、需要历史经验时。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的问题或关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多几条，默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_index',
    description: '看本地知识库的目录：有哪些分区、每个分区几条、最近几条标题。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kb_stage',
    description: '把材料放进「待分区」收件箱（最多 5 块），只写收件箱、不写主库；人再决定挪到哪个分区。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '材料标题' },
        text: { type: 'string', description: '材料正文（Markdown 优先）' },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'kb_recommend',
    description: '给某条经验提建议：转正或推翻，必须带理由。只进「待拍板」，由人一票决定，AI 不执行。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '经验块的 id' },
        action: { type: 'string', enum: ['promote', 'refute'], description: 'promote=建议转正，refute=建议推翻' },
        reason: { type: 'string', description: '为什么要这样建议，说人话' },
      },
      required: ['id', 'action', 'reason'],
    },
  },
]

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function newSession(client, home) {
  if (editorSeq === null) editorSeq = loadEditorSeq(home)
  const id = `mcp-${Math.random().toString(16).slice(2, 10)}`
  const editor = `E-${String(++editorSeq).padStart(3, '0')}`
  const session = {
    id,
    editor,
    client: String(client?.name ?? 'unknown').slice(0, 40),
    version: String(client?.version ?? '').slice(0, 20),
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    calls: 0,
  }
  sessions.set(id, session)
  return session
}

function logActivity(home, session, tool, detail) {
  if (!home) return
  try {
    const dir = path.join(home, '_mcp')
    fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      editor: session?.editor ?? 'E-???',
      client: session?.client ?? 'unknown',
      tool,
      detail,
    })
    fs.appendFileSync(path.join(dir, 'activity.jsonl'), line + '\n')
  } catch { /* 日志失败不影响查询 */ }
}

function formatConsult(db, args) {
  const query = String(args?.query ?? '').trim()
  if (!query) return textResult('缺少 query。')
  const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 10)
  const result = consult(db, query, { limit })
  const lines = [`判定：${result.consult ? '查库' : '不查'}（${result.reason}）`]
  if (result.summary) lines.push('', '索引摘要：', result.summary)
  if (result.rows.length) {
    lines.push('', `命中 ${result.rows.length} 条：`)
    for (const row of result.rows) {
      lines.push(`- ${row.id}｜${row.domain}｜${row.type}｜${row.title}`)
      if (row.summary) lines.push(`  ${row.summary}`)
    }
  } else if (result.zeroHit?.text) {
    lines.push('', result.zeroHit.text)
  } else {
    lines.push('', '没有命中。')
  }
  if (result.warnings?.length) {
    lines.push('', `⚠ 反例警示 ${result.warnings.length} 条：`)
    for (const warning of result.warnings) lines.push(`- ${warning.title ?? warning.id}：${warning.summary ?? ''}`)
  }
  return textResult(lines.join('\n'))
}

function formatIndex(db) {
  const summary = indexSummary(db).text
  const c = counts(db)
  return textResult(`本地知识库：${c.blocks} 块（知识 ${c.knowledge}，经验 ${c.experience}）\n${summary}`)
}

/**
 * 处理一次 MCP 请求。
 * @returns {Promise<{status:number, body?:object, headers?:object}>}
 */
export 
// ---------- 开关状态（存在 home/_mcp/state.json，默认关）----------

function statePath(home) {
  return home ? path.join(home, '_mcp', 'state.json') : ''
}

/** 读开关；文件不存在时默认关闭。 */
export function mcpEnabled(home) {
  const file = statePath(home)
  if (!file) return false
  try {
    return Boolean(JSON.parse(fs.readFileSync(file, 'utf8')).enabled)
  } catch {
    return false
  }
}

/** 写开关并返回最新状态。 */
export function setMcpEnabled(home, enabled) {
  const file = statePath(home)
  if (!file) throw new Error('没有库目录，无法保存 MCP 开关')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ enabled: Boolean(enabled), updatedAt: new Date().toISOString() }, null, 2))
  return Boolean(enabled)
}
/**
 * 处理一次 MCP 请求。
 * @returns {Promise<{status:number, body?:object, headers?:object}>}
 */
export async function handleMcp(body, db, { home, sessionId } = {}) {
  if (!mcpEnabled(home)) {
    return { status: 403, body: { ok: false, error: 'MCP 已关闭。在面板的 MCP 页点「启动 MCP」。' } }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, '只支持单个 JSON-RPC 请求') }
  }
  const { id = null, method, params } = body
  if (typeof method !== 'string') return { status: 400, body: rpcError(id, -32600, '缺少 method') }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202 }
  }

  if (method === 'initialize') {
    const session = newSession(params?.clientInfo, home)
    const summary = indexSummary(db, { topDomains: 5, titlesPerDomain: 2 }).text
    return {
      status: 200,
      headers: { 'Mcp-Session-Id': session.id },
      body: rpcResult(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        specVersion: SPEC_VERSION,
        readOnly: false,
        writeScope: WRITE_SCOPE,
        instructions: [
          '本地经验库。用法：',
          '1. 技术问题、排错、需要历史经验时先调 kb_consult(query)；闲聊不查；零命中就用自己的知识答，并说明不是来自本库。',
          '2. 想知道库的结构，调 kb_index()；索引摘要也会随本说明给出。',
          '3. 返回的是简介，不是全文；要下结论前请读正文，或向用户要。',
          `4. 写入是受限的：${WRITE_SCOPE}。新材料用 kb_stage 进收件箱，不要说自己“已入库”。`,
          '5. 用了经验用 kb_record 记账；想改结论用 kb_recommend + 理由，只进「待拍板」，由人决定。',
          '6. 主库的增删改、转正、推翻都只能由人做；不要直接改文件。',
          '7. 后续请求带上 initialize 返回的 Mcp-Session-Id 头，否则会被拒绝。',
          '8. 自检：连上后先调 kb_index()，能返回块数就是连上了；块数为 0 只说明库是空的，不是没连上。缺参数或缺会话头会返回 -32602。',
          `你的连接编号：${session.editor}（已记录 clientInfo：${session.client}）。`,
          '库的目录：',
          summary,
        ].join('\n'),
      }),
    }
  }

  if (method === 'ping') return { status: 200, body: rpcResult(id, {}) }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) }
  }

  if (method === 'tools/call') {
    const session = sessions.get(sessionId)
    if (!session) {
      return { status: 200, body: rpcError(id, -32602, '先 initialize 领取连接编号，再调用工具') }
    }
    session.lastSeen = new Date().toISOString()
    session.calls += 1
    const name = params?.name
    const args = params?.arguments ?? {}
    try {
      if (name === 'kb_consult') {
        logActivity(home, session, 'kb_consult', { query: String(args?.query ?? '').slice(0, 200) })
        return { status: 200, body: rpcResult(id, formatConsult(db, args)) }
      }
      if (name === 'kb_index') {
        logActivity(home, session, 'kb_index', {})
        return { status: 200, body: rpcResult(id, formatIndex(db)) }
      }
      if (name === 'kb_stage') {
        const title = String(args?.title ?? '').trim()
        const text = String(args?.text ?? '').trim()
        if (!title || !text) return { status: 200, body: rpcResult(id, textResult('title 和 text 都要填。')) }
        const plan = planIngest(db, { title, text })
        plan.chunks = plan.chunks.slice(0, 5)
        const created = applyPlan(db, home, plan, { domain: '待分区' })
        logActivity(home, session, 'kb_stage', { title: title.slice(0, 120), blocks: created.length })
        return {
          status: 200,
          body: rpcResult(id, textResult([
            `已放进待分区 ${created.length} 块（只进收件箱，主库未动）：`,
            ...created.map((item) => `- ${item.id}｜${item.title}`),
            '',
            '人再决定挪到哪个分区。',
          ].join('\n'))),
        }
      }
      if (name === 'kb_recommend') {
        const target = String(args?.id ?? '').trim()
        const action = String(args?.action ?? '')
        const reason = String(args?.reason ?? '').trim()
        if (!target || !['promote', 'refute'].includes(action) || !reason) {
          return { status: 200, body: rpcResult(id, textResult('需要 id、action（promote/refute）和 reason。')) }
        }
        const result = submit(db, home, { action, payload: { id: target }, reason })
        logActivity(home, session, 'kb_recommend', { id: target, action, status: result.status })
        if (result.status === 'pending') {
          return { status: 200, body: rpcResult(id, textResult(`已放进「待拍板」#${result.seq}，等用户一票决定。理由：${reason}`)) }
        }
        return { status: 200, body: rpcResult(id, textResult(`没提成：${result.reason ?? result.status}`)) }
      }
      return { status: 200, body: rpcError(id, -32602, `未知工具：${name}`) }
    } catch (error) {
      return { status: 200, body: rpcError(id, -32603, `执行失败：${String(error?.message ?? error)}`) }
    }
  }

  return { status: 200, body: rpcError(id, -32601, `不支持的方法：${method}`) }
}

/** 给面板用：MCP 的静态信息 + 当前连接。 */
export function mcpInfo(home) {
  return {
    enabled: mcpEnabled(home),
    protocol: PROTOCOL,
    specVersion: SPEC_VERSION,
    server: SERVER,
    tools: TOOLS,
    readOnly: false,
    writeScope: WRITE_SCOPE,
    sessions: [...sessions.values()],
  }
}











