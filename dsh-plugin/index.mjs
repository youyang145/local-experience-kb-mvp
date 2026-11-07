/**
 * dsh-plugin-local-kb —— 本地知识库插件（MVP）
 *
 * 给模型三个工具：kb_consult / kb_index / kb_stage。
 * 库逻辑打包在 lib/kb 里，插件不依赖外部路径；home 仍指向本机知识库目录。
 *
 * 设计约束：
 *   - 不依赖 @deepseek-ai/dsh-tools：工具描述直接用注册表认的 JSON Schema 形状；
 *   - 写只写「待分区」收件箱，主库仍由人拍板。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_HOME = 'F:\\大项目开发\\dsh插件本地知识库\\测试数据\\_test-kb-m1'
const DEFAULT_CODE = path.join(here, 'lib', 'kb')
const DEFAULT_PANEL = 'http://127.0.0.1:7788'

export const name = 'local-kb'
export const inject = ['tools']

function format(result) {
  if (!result.consult) return `不查库：${result.reason}`
  const lines = ['判定：查库', '', '索引摘要：', result.summary, '']
  if (!result.rows.length) lines.push(result.zeroHit?.text ?? '没有命中。')
  else {
    lines.push(`命中 ${result.rows.length} 条：`)
    for (const row of result.rows) {
      lines.push(`- ${row.id}｜${row.domain}｜${row.type === 'experience' ? '经验' : '知识'}｜${row.title}`)
      if (row.summary) lines.push(`  ${row.summary}`)
    }
  }
  if (result.warnings?.length) {
    lines.push('', `⚠ 反例 ${result.warnings.length} 条：`)
    for (const warning of result.warnings) {
      lines.push(`- ${warning.claim}（被 ${warning.refuted_by.join(', ') || '未填'} 推翻）`)
    }
  }
  return lines.join('\n')
}

/** 工具定义：parameters/output 用注册表直接认的 JSON Schema 形状。 */
export function createTool({ home, code }) {
  const load = (file) => import(pathToFileURL(path.join(code, file)).href)
  return {
    name: 'kb_consult',
    description: '查本地知识库：先判断这轮要不要查（闲聊跳过），返回分区索引摘要、命中简介和反例警示。适合在动手答题或做事之前调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '要查的问题或关键词' },
        limit: { type: 'integer', description: '最多返回几条，默认 5' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const [{ openDb }, { layout }, { consult }] = await Promise.all([
        load('db.mjs'),
        load('config.mjs'),
        load('consult.mjs'),
      ])
      const db = openDb(layout(home).db)
      try {
        return { text: format(consult(db, args.query, { limit: args.limit ?? 5 })) }
      } finally {
        db.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `查库：${args.query}`, kind: 'other', rawInput: args }),
  }
}

/** kb_index：只返回分区目录，不检索、不读书。 */
export function createIndexTool({ home, code }) {
  const load = (file) => import(pathToFileURL(path.join(code, file)).href)
  return {
    name: 'kb_index',
    description: '返回本地知识库的分区目录与每个分区的条数，用来判断"库里有没有相关分区"。不检索、不读正文。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const [{ openDb }, { layout }, { indexSummary }] = await Promise.all([
        load('db.mjs'), load('config.mjs'), load('consult.mjs'),
      ])
      const db = openDb(layout(home).db)
      try {
        return { text: indexSummary(db, { topDomains: 12, titlesPerDomain: 2 }).text }
      } finally {
        db.close()
      }
    },
    presentCall: () => ({ card: 'generic', title: '看知识库目录', kind: 'other', rawInput: {} }),
  }
}

/**
 * kb_stage：把材料分块后放进「待分区」收件箱。
 * 只能进待分区，不能写主库；一次最多 5 块，人再决定挪到哪。
 */
export function createStageTool({ home, code }) {
  const load = (file) => import(pathToFileURL(path.join(code, file)).href)
  return {
    name: 'kb_stage',
    description: '把一段材料分块后放进知识库的「待分区」收件箱，并给每块附上候选分区。只能进收件箱，不会写主库；一次最多 5 块。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '材料标题，用来命名块' },
        text: { type: 'string', description: '材料正文（Markdown 优先）' },
      },
      required: ['title', 'text'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const [{ openDb }, { layout }, { planIngest, applyPlan }] = await Promise.all([
        load('db.mjs'), load('config.mjs'), load('ingest.mjs'),
      ])
      const db = openDb(layout(home).db)
      try {
        const plan = planIngest(db, { title: args.title, text: args.text })
        plan.chunks = plan.chunks.slice(0, 5)
        const created = applyPlan(db, home, plan, { domain: '待分区' })
        const lines = [`已放进待分区 ${created.length} 块（收件箱，主库未动）：`]
        for (const item of created) lines.push(`- ${item.id}｜${item.title}`)
        lines.push('', '人再决定挪到哪个分区；候选：')
        for (const chunk of plan.chunks) {
          const top = chunk.suggestions.map((s) => `${s.domain}(${s.score})`).join('、') || '（无候选）'
          lines.push(`- ${chunk.title}：${top}`)
        }
        return { text: lines.join('\n') }
      } finally {
        db.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `放进待分区：${args.title}`, kind: 'other', rawInput: args }),
  }
}

/**
 * kb_record：AI 自己记账。
 * 套用成功/失败、同一问题又出现，都由模型顺手记，不用人去点按钮。
 * 只动计数，不动判断，也不写主库。
 */
export function createRecordTool({ home, code }) {
  const load = (file) => import(pathToFileURL(path.join(code, file)).href)
  return {
    name: 'kb_record',
    description: '记账：你在对话里实际套用了某条经验、或同一问题又出现时调用。只改使用/成功/复现计数，不改判断，不写主库。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '经验块的 id' },
        outcome: { type: 'string', enum: ['success', 'failure', 'unknown'], description: '这次套用的结果，默认 unknown' },
        repeat: { type: 'boolean', description: 'true = 同一问题又出现（记复现），不记套用' },
      },
      required: ['id'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const [{ openDb, getBlock }, { layout }, { applyUse, recordOccurrence }] = await Promise.all([
        load('db.mjs'), load('config.mjs'), load('experience.mjs'),
      ])
      const db = openDb(layout(home).db)
      try {
        const row = getBlock(db, args.id)
        if (!row || row.type !== 'experience') return { text: `没找到经验 ${args.id}` }
        const exp = args.repeat
          ? recordOccurrence(db, home, args.id)
          : applyUse(db, home, args.id, { result: args.outcome ?? 'unknown', method: 'self' })
        return {
          text: `已记账 ${args.id}：用过 ${exp.accounting.used}｜成了 ${exp.accounting.succeeded}｜复现 ${exp.accounting.occurrences}`,
        }
      } finally {
        db.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `记账：${args.id}`, kind: 'other', rawInput: args }),
  }
}

/**
 * kb_recommend：AI 给建议，人一票决定。
 * 只提交建议（转正 / 推翻）并附理由，进「待拍板」；真正执行由人点同意。
 */
export function createRecommendTool({ home, code }) {
  const load = (file) => import(pathToFileURL(path.join(code, file)).href)
  return {
    name: 'kb_recommend',
    description: '向用户提一条建议并解释：建议把某条经验转正，或建议推翻它。会进入「待拍板」，用户一票同意或否决，AI 不会自己执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '经验块的 id' },
        action: { type: 'string', enum: ['promote', 'refute'], description: 'promote = 建议转正；refute = 建议推翻' },
        reason: { type: 'string', description: '为什么要这样建议，说人话，给用户看' },
      },
      required: ['id', 'action', 'reason'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const [{ openDb }, { layout }, { submit }] = await Promise.all([
        load('db.mjs'), load('config.mjs'), load('proposals.mjs'),
      ])
      const db = openDb(layout(home).db)
      try {
        const result = submit(db, home, {
          action: args.action,
          payload: { id: args.id },
          reason: args.reason,
        })
        if (result.status === 'pending') return { text: `已放进「待拍板」#${result.seq}，等用户一票决定：${args.reason}` }
        if (result.status === 'skipped') return { text: `这次没提成：${result.reason}` }
        if (result.status === 'off') return { text: `经验生成已关闭：${result.reason}` }
        return { text: `已提交（${result.status}）` }
      } finally {
        db.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `建议${args.action === 'promote' ? '转正' : '推翻'}：${args.id}`, kind: 'other', rawInput: args }),
  }
}

/** 挂件脚本本体与注入：宿主把 /dsh-kb/widget.js 塞进 Web 页面。 */
function mountWidget(ctx, { panelUrl, home }) {
  const widgetPath = path.join(here, 'widget.js')
  const tag = '<script defer src="/dsh-kb/widget.js"></script>'

  const serveWidget = (req, res) => {
    try {
      const code = fs.readFileSync(widgetPath, 'utf8')
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(code)
    } catch {
      res.writeHead(500)
      res.end('/* widget missing */')
    }
  }

  // 面板不随 DSH 启动就点亮：由挂件上的「启动」按钮显式拉起，「中断」停掉。
  let panelPromise = null
  const panel = { server: null, url: '' }

  const ensurePanel = () => {
    if (!panelPromise) {
      panelPromise = (async () => {
        const { startServer } = await import(pathToFileURL(path.join(DEFAULT_CODE, 'server.mjs')).href)
        const started = await startServer({ home, port: 7788, host: '127.0.0.1' })
        panel.server = started.server
        panel.url = started.url
        if (typeof ctx.on === 'function') ctx.on('dispose', () => started.server?.close())
        console.log('[local-kb] 面板已启动：' + started.url)
        return started.url
      })().catch((error) => {
        panelPromise = null
        const message = String(error?.message ?? error)
        if (message.includes('EADDRINUSE')) {
          panel.url = 'http://127.0.0.1:7788'
          return panel.url
        }
        throw error
      })
    }
    return panelPromise
  }

  // 中断 = 优雅停：不再接新连接，正在处理的请求做完；不 force-kill 进程。
  const stopPanel = () => {
    const server = panel.server
    if (!server) return false
    try { server.closeIdleConnections?.() } catch { /* 老版本没有就算了 */ }
    server.close()
    panel.server = null
    panel.url = ''
    panelPromise = null
    console.log('[local-kb] 面板已中断')
    return true
  }

  const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(payload))
  }

  const serveStart = async (req, res) => {
    try {
      const url = await ensurePanel()
      sendJson(res, 200, { ok: true, running: true, url })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const serveStop = (req, res) => {
    const stopped = stopPanel()
    sendJson(res, 200, { ok: true, stopped, running: Boolean(panel.server) })
  }

  const serveStatus = (req, res) => {
    sendJson(res, 200, { ok: true, running: Boolean(panel.server), url: panel.url })
  }

  try {
    if (ctx.webServer?.register) {
      ctx.webServer.register({ kind: 'exact', path: '/dsh-kb/widget.js', handler: serveWidget })
      ctx.webServer.register({ kind: 'exact', path: '/dsh-kb/start', handler: serveStart })
      ctx.webServer.register({ kind: 'exact', path: '/dsh-kb/stop', handler: serveStop })
      ctx.webServer.register({ kind: 'exact', path: '/dsh-kb/status', handler: serveStatus })
    }
    if (ctx.webServer?.tapIndex) {
      ctx.webServer.tapIndex((html) => {
        if (html.includes('/dsh-kb/widget.js')) return html
        return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
      })
    }
  } catch (error) {
    console.warn('[local-kb] 挂件注入失败（不影响工具）：' + String(error?.message ?? error))
  }
}

export function apply(ctx, config = {}) {
  const options = {
    home: config.home ?? DEFAULT_HOME,
    code: config.code ?? DEFAULT_CODE,
  }
  ctx.tools.register(createTool(options))
  ctx.tools.register(createIndexTool(options))
  ctx.tools.register(createStageTool(options))
  ctx.tools.register(createRecordTool(options))
  ctx.tools.register(createRecommendTool(options))

  // 自动查库的第一层：每轮把索引简介注入上下文（便宜），需要细节再由模型调 kb_consult。
  mountAutoIndex(ctx, { home: options.home, code: options.code })

  // Web 服务可能晚于插件就绪：有就等它，没有就只做工具（headless 环境）。
  const panelUrl = config.panelUrl ?? DEFAULT_PANEL
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (inner) => mountWidget(inner, { panelUrl, home: options.home }))
    } else if (ctx.webServer) {
      mountWidget(ctx, { panelUrl, home: options.home })
    }
  } catch (error) {
    console.warn('[local-kb] webServer 不可用，跳过挂件：' + String(error?.message ?? error))
  }
}

/**
 * 每轮自动注入索引简介 + 召回规则。
 *
 * 放 systemPrompt.section（系统提示层，每轮重新组装、压缩时受保护），
 * 不放 context（用户角色快照，压缩时可能被盖掉）。
 */
function mountAutoIndex(ctx, { home, code }) {
  const register = (inner) => {
    const sp = inner?.systemPrompt
    if (!sp || (typeof sp.section !== 'function' && typeof sp.context !== 'function')) return
    ;(async () => {
      const [{ openDb }, { layout }, { indexSummary }] = await Promise.all([
        import(pathToFileURL(path.join(code, 'db.mjs')).href),
        import(pathToFileURL(path.join(code, 'config.mjs')).href),
        import(pathToFileURL(path.join(code, 'consult.mjs')).href),
      ])
      let cache = { at: 0, text: '' }
      const text = () => {
        const now = Date.now()
        if (now - cache.at < 15000) return cache.text
        try {
          const db = openDb(layout(home).db)
          try {
            const summary = indexSummary(db, { topDomains: 6, titlesPerDomain: 2 }).text
            cache = summary && !summary.includes('（库是空的）')
              ? {
                  at: now,
                  text: [
                    '【本地经验库】先看索引，需要细节 / 反例 / 经验账本时调用 kb_consult，不要凭记忆编；闲聊不用查。',
                    summary,
                  ].join('\n'),
                }
              : { at: now, text: '' }
          } finally {
            db.close()
          }
        } catch {
          cache = { at: now, text: '' }
        }
        return cache.text
      }
      if (typeof sp.section === 'function') {
        sp.section({ name: 'local-kb:index', order: 400, text, interpolate: false })
      } else {
        sp.context({ name: 'local-kb:index', order: 300, text })
      }
    })().catch((error) => console.warn('[local-kb] 索引注入失败：' + String(error?.message ?? error)))
  }

  try {
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], register)
    else register(ctx)
  } catch (error) {
    console.warn('[local-kb] systemPrompt 不可用，跳过自动索引：' + String(error?.message ?? error))
  }
}
