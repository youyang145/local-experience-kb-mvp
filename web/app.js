/**
 * 本地知识库面板（独立版）。
 * 数据全部来自 /api/*；同一套代码以后可以套进 DSH 客户端插件。
 */

import { createSphere } from './sphere.js'
import { api } from './api.js'
import { state, $, esc, fmt, typeTag, crumbs, KNOWLEDGE_KINDS } from './shared.js'
import { viewKb } from './views/kb.js'
import { viewExp } from './views/experience.js'


let toastTimer = null
function toast(message, isError = false) {
  let node = $('.toast')
  if (!node) {
    node = document.createElement('div')
    node.className = 'toast'
    document.body.appendChild(node)
  }
  node.textContent = message
  node.classList.toggle('err', isError)
  node.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('show'), 2400)
}

// ---------- 数据 ----------

async function loadOverview() {
  state.overview = await api('/api/overview')
  state.settings = state.overview.settings
  renderChips()
  $('#data-home').textContent = state.overview.home
}

async function loadBlocks() {
  if (state.q.trim()) {
    const data = await api(`/api/search?q=${encodeURIComponent(state.q)}&limit=60`)
    state.blocks = data.rows
    state.warnings = data.warnings
    return
  }
  const params = new URLSearchParams()
  if (state.domain) params.set('domain', state.domain)
  params.set('limit', '300')
  state.blocks = await api(`/api/blocks?${params}`)
  state.warnings = []
}

async function openBlock(id) {
  state.detail = await api(`/api/blocks/${encodeURIComponent(id)}`)
  render()
  saveUi()
}

async function loadExperiences() {
  state.experiences = await api('/api/experiences?all=1')
}

async function loadProposals() {
  state.proposals = await api('/api/proposals')
  const count = state.proposals.length
  $('#proposal-count').textContent = String(count)
  $('#btn-proposals').style.display = count ? '' : 'none'
}

// ---------- 渲染 ----------

function renderChips() {
  const s = state.overview?.stats
  if (!s) return
  $('#chips').innerHTML = [
    `<span class="chip">块 <b>${s.blocks}</b></span>`,
    `<span class="chip">经验 <b>${s.experience}</b></span>`,
    `<span class="chip">小经验区 <b>${s.probation}</b></span>`,
  ].join('')
}

function render() {
  document.querySelectorAll('#nav button[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view)
  })
  const main = $('#main')
  const active = document.activeElement?.id
  const pos = document.activeElement?.selectionStart ?? null

  // 记住滚动位置：列表点开详情时不能跳回顶部
  const sameView = state.__renderedView === state.view
  const scrollMemory = {
    main: sameView ? main.scrollTop : 0,
    list: sameView ? ($('.listpane')?.scrollTop ?? 0) : 0,
  }
  const detailChanged = state.__renderedDetail !== (state.detail?.id ?? null)


  if (state.view === 'kb') main.innerHTML = viewKb()
  else if (state.view === 'exp') main.innerHTML = viewExp()
  else if (state.view === 'index') main.innerHTML = viewIndex()
  else if (state.view === 'mcp') main.innerHTML = viewMcp()
  else if (state.view === 'settings') main.innerHTML = viewSettings()

  main.scrollTop = scrollMemory.main
  const listEl = $('.listpane')
  if (listEl) listEl.scrollTop = scrollMemory.list
  if (detailChanged) {
    const detailEl = $('.detail')
    if (detailEl) detailEl.scrollTop = 0
  }

  state.__renderedView = state.view
  state.__renderedDetail = state.detail?.id ?? null

  if (active && document.getElementById(active)) {
    const node = document.getElementById(active)
    node.focus()
    if (pos != null && node.setSelectionRange) node.setSelectionRange(pos, pos)
  }
  bind()
  if (state.view === 'index' && state.indexMode === 'graph') mountGraph()
  if (state.view === 'mcp') loadAuth()
}

// ---------- 索引：可缩放矩形树图（面积 = 条数） ----------

function treeNodeAt(pathSegs) {
  let nodes = state.overview?.tree ?? []
  let node = null
  for (const seg of pathSegs) {
    node = nodes.find((n) => n.name === seg || n.path === pathSegs.join('/'))
    if (!node) return null
    nodes = node.children ?? []
  }
  return node
}

function indexItems() {
  const pathSegs = state.indexPath ?? []
  if (!pathSegs.length) {
    return (state.overview?.tree ?? []).map((n) => ({ key: n.path, label: n.name, count: n.count, kind: 'node' }))
  }
  const node = treeNodeAt(pathSegs)
  const children = node?.children ?? []
  if (children.length) {
    return children.map((n) => ({ key: n.path, label: n.name, count: n.count, kind: 'node' }))
  }
  const prefix = pathSegs.join('/')
  return state.blocks
    .filter((b) => b.domain === prefix || b.domain.startsWith(prefix + '/'))
    .map((b) => ({ key: b.id, label: b.title, count: 1, kind: 'block', block: b }))
}

/** 简单切分树图：按权重二分，交替横竖切。 */
function layoutTreemap(items, x = 0, y = 0, w = 1000, h = 560, vertical = true) {
  if (!items.length) return []
  if (items.length === 1) return [{ ...items[0], rect: { x, y, w, h } }]
  const total = items.reduce((sum, it) => sum + Math.max(it.count, 1), 0)
  let acc = 0
  let split = 1
  for (let i = 0; i < items.length; i += 1) {
    acc += Math.max(items[i].count, 1)
    if (acc >= total / 2) { split = Math.max(1, Math.min(i + 1, items.length - 1)); break }
  }
  const left = items.slice(0, split)
  const right = items.slice(split)
  const leftTotal = left.reduce((sum, it) => sum + Math.max(it.count, 1), 0)
  const ratio = leftTotal / total
  if (vertical) {
    const lw = w * ratio
    return [...layoutTreemap(left, x, y, lw, h, false), ...layoutTreemap(right, x + lw, y, w - lw, h, false)]
  }
  const lh = h * ratio
  return [...layoutTreemap(left, x, y, w, lh, true), ...layoutTreemap(right, x, y + lh, w, h - lh, true)]
}

function viewIndex() {
  const o = state.overview
  if (!o) return ''
  const s = o.stats
  const pathSegs = state.indexPath ?? []
  const items = indexItems().sort((a, b) => b.count - a.count)
  const rects = layoutTreemap(items)
  const crumb = ['全部', ...pathSegs]
    .map((label, depth) => depth === 0
      ? `<button class="link ${depth === pathSegs.length ? 'on' : ''}" data-index-crumb="0">全部</button>`
      : `<span class="dim">/</span> <button class="link ${depth === pathSegs.length ? 'on' : ''}" data-index-crumb="${depth}">${esc(label)}</button>`)
    .join(' ')

  const cells = rects.map((item) => {
    const r = item.rect
    const attrs = item.kind === 'node'
      ? `data-index-node="${esc(item.key)}"`
      : `data-open="${esc(item.block.id)}"`
    const cls = item.kind === 'node' ? 'tm-cell node' : 'tm-cell block'
    const count = item.kind === 'node' ? `<span class="tm-count">${item.count}</span>` : ''
    return `<div class="${cls}" ${attrs} style="left:${(r.x / 10).toFixed(2)}%;top:${(r.y / 5.6).toFixed(2)}%;width:${(r.w / 10).toFixed(2)}%;height:${(r.h / 5.6).toFixed(2)}%">
      <span class="tm-label">${esc(item.label)}</span>${count}
    </div>`
  }).join('')

  const topChips = (o.tree ?? []).slice(0, 14)
    .map((n) => `<button class="chipbtn ${pathSegs[0] === n.name ? 'on' : ''}" data-index-node="${esc(n.path)}">${esc(n.name)} <span class="dim">${n.count}</span></button>`)
    .join('')

  const mode = state.indexMode ?? 'treemap'
  const modeBtns = `
    <div class="tm-modes">
      <button class="chipbtn ${mode === 'treemap' ? 'on' : ''}" data-index-mode="treemap">树图</button>
      <button class="chipbtn ${mode === 'graph' ? 'on' : ''}" data-index-mode="graph">图谱</button>
    </div>`

  if (mode === 'graph') {
    const graphPath = state.graphPath ?? []
    const gcrumb = ['全部', ...graphPath]
      .map((label, depth) => depth === 0
        ? `<button class="link ${graphPath.length === 0 ? 'on' : ''}" data-graph-crumb="0">全部</button>`
        : `<span class="dim">/</span> <button class="link ${depth === graphPath.length ? 'on' : ''}" data-graph-crumb="${depth}">${esc(label)}</button>`)
      .join(' ')
    return `
      <div class="tm-head">
        <div>
          <div class="tm-title">索引 · 图谱</div>
          <div class="tm-crumb">
            ${graphPath.length ? '<button class="link" data-graph-back="1">← 返回</button>' : ''}
            ${gcrumb}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:14px">
          <div class="tm-hint">点分区进入下一级 · 拖动节点 · 滚轮缩放 · 点块看详情</div>
          ${modeBtns}
        </div>
      </div>
      <div class="graph-stage" id="graph-stage"></div>
      <div class="tm-foot">
        <span>块 ${s.blocks} ｜ 知识 ${s.knowledge} ｜ 经验 ${s.experience} ｜ 小经验区 ${s.probation} ｜ 反例 ${s.refuted} ｜ 孤儿 ${o.orphans}</span>
        <span class="dim">${graphPath.length === 0 ? '顶层是分区，点进去继续' : '线 = 血缘（融合/派生/替代）'}</span>
      </div>`
  }

  return `
    <div class="tm-head">
      <div>
        <div class="tm-title">索引</div>
        <div class="tm-crumb">${crumb}</div>
      </div>
      <div style="display:flex;align-items:center;gap:14px">
        <div class="tm-hint">面积 = 条数 · 点分区钻进去 · 点块直接开详情</div>
        ${modeBtns}
      </div>
    </div>
    <div class="tm-stage">${cells || '<div class="empty small"><p class="dim">这里还没有块。</p></div>'}</div>
    <div class="tm-foot">
      <span>块 ${s.blocks} ｜ 知识 ${s.knowledge} ｜ 经验 ${s.experience} ｜ 小经验区 ${s.probation} ｜ 反例 ${s.refuted} ｜ 孤儿 ${o.orphans}</span>
      <span class="tm-chips">${topChips}</span>
    </div>`
}

function graphNodes() {
  const path = state.graphPath ?? []
  if (!path.length) {
    return (state.overview?.tree ?? []).map((n) => ({ kind: 'domain', key: n.path, label: n.name, count: n.count }))
  }
  const node = treeNodeAt(path)
  if (node?.children?.length) {
    return node.children.map((n) => ({ kind: 'domain', key: n.path, label: n.name, count: n.count }))
  }
  const prefix = path.join('/')
  return state.blocks
    .filter((b) => b.domain === prefix || b.domain.startsWith(prefix + '/'))
    .map((b) => ({ kind: 'block', key: b.id, label: b.title, block: b }))
}

function mountGraph() {
  const host = document.getElementById('graph-stage')
  if (!host) return
  state.graphHandle?.stop?.()
  const path = state.graphPath ?? []
  const items = graphNodes()
  const W = host.clientWidth || 1000
  const H = Math.max(360, host.clientHeight || 520)
  if (!items.length) {
    host.innerHTML = '<div class="empty small"><p class="dim">这一级还没有内容。</p></div>'
    return
  }
  // 叶子层太多时，力导向会糊；超过阈值就切成可滚动列表
  if (items.length > 36) {
    host.innerHTML = `<div class="graph-list">${items.map((item) => `
      <button class="graph-card" data-block-id="${esc(item.key)}" data-block-type="${esc(item.block?.type ?? 'knowledge')}">
        <b>${esc(item.label)}</b>
        <span class="dim">${esc(item.block?.domain ?? '')}</span>
      </button>`).join('')}</div>`
    host.querySelectorAll('.graph-card').forEach((card) => {
      card.onclick = async () => {
        const type = card.dataset.blockType
        state.view = type === 'experience' ? 'exp' : 'kb'
        state.detail = null
        await loadBlocks()
        if (state.view === 'exp') await loadExperiences()
        await openBlock(card.dataset.blockId)
      }
    })
    return
  }
  const nodes = items.map((item, i) => ({
    ...item,
    id: item.key,
    x: W / 2 + Math.cos(i * 2.399) * (Math.min(W, H) * 0.26),
    y: H / 2 + Math.sin(i * 2.399) * (Math.min(W, H) * 0.26),
    vx: 0, vy: 0,
    r: item.kind === 'domain' ? 10 + Math.min(14, Math.sqrt(item.count || 1) * 2.4) : 6 + Math.min(8, Math.sqrt(Math.max(1, item.block?.priority ?? 1)) / 3),
    fixed: false, moved: 0,
  }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = []
  if (path.length) {
    for (const node of nodes) {
      const lin = node.block?.lineage ?? {}
      for (const key of ['fused_from', 'derived_from']) {
        for (const parent of lin[key] ?? []) if (byId.has(parent)) edges.push({ a: byId.get(parent), b: node, kind: key })
      }
      if (lin.superseded_by && byId.has(lin.superseded_by)) edges.push({ a: node, b: byId.get(lin.superseded_by), kind: 'superseded' })
    }
  }

  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.classList.add('graph-svg')
  const zoom = document.createElementNS(svgNS, 'g')
  const edgeLayer = document.createElementNS(svgNS, 'g')
  const nodeLayer = document.createElementNS(svgNS, 'g')
  zoom.append(edgeLayer, nodeLayer)
  svg.append(zoom)
  host.append(svg)

  const colorOf = (node) => {
    if (node.kind === 'domain') return '#7ee0c2'
    const exp = node.block?.type === 'experience' ? node.block : null
    if (!exp) return '#5f8fd9'
    return exp.status === 'refuted' ? '#e5484d' : exp.tier === 'probation' ? '#f0b429' : '#6ea8fe'
  }
  const lines = edges.map((edge) => {
    const line = document.createElementNS(svgNS, 'line')
    line.setAttribute('stroke', edge.kind === 'superseded' ? 'rgba(229,72,77,.55)' : 'rgba(110,168,254,.35)')
    line.setAttribute('stroke-width', '1.2')
    line.setAttribute('stroke-dasharray', edge.kind === 'superseded' ? '4 4' : '')
    edgeLayer.append(line)
    return { edge, el: line }
  })

  for (const node of nodes) {
    const g = document.createElementNS(svgNS, 'g')
    g.classList.add('graph-node')
    const circle = document.createElementNS(svgNS, 'circle')
    circle.setAttribute('r', String(node.r))
    circle.setAttribute('fill', colorOf(node))
    circle.setAttribute('fill-opacity', node.kind === 'domain' ? '0.18' : '0.85')
    circle.setAttribute('stroke', node.kind === 'domain' ? 'rgba(126,224,194,.7)' : 'rgba(255,255,255,.5)')
    circle.setAttribute('stroke-width', node.kind === 'domain' ? '1.6' : '0.8')
    const text = node.kind === 'domain' ? `${node.label}  ${node.count ?? ''}` : node.label
    const label = document.createElementNS(svgNS, 'text')
    label.textContent = String(text ?? '').slice(0, node.kind === 'domain' ? 12 : 16)
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('y', String(node.r + 13))
    label.classList.add('graph-label')
    g.append(circle, label)
    nodeLayer.append(g)
    node.el = g
    g.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
      node.fixed = true
      node.moved = 0
      const point = toLocal(event)
      node.dragX = point.x - node.x
      node.dragY = point.y - node.y
      g.setPointerCapture?.(event.pointerId)
    })
    g.addEventListener('pointermove', (event) => {
      if (!node.fixed) return
      const point = toLocal(event)
      node.moved += Math.abs(point.x - node.x) + Math.abs(point.y - node.y)
      node.x = clamp(point.x - node.dragX, node.r + 30, W - node.r - 30)
      node.y = clamp(point.y - node.dragY, node.r + 20, H - node.r - 20)
      node.vx = 0
      node.vy = 0
    })
    g.addEventListener('pointerup', () => { node.fixed = false })
    g.addEventListener('click', async () => {
      if (node.moved >= 4) { node.moved = 0; return }
      if (node.kind === 'domain') {
        state.graphPath = String(node.key).split('/').filter(Boolean)
        render()
        return
      }
      state.view = node.block?.type === 'experience' ? 'exp' : 'kb'
      state.detail = null
      await loadBlocks()
      if (state.view === 'exp') await loadExperiences()
      await openBlock(node.id)
    })
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }
  function toLocal(event) {
    const rect = svg.getBoundingClientRect()
    const scale = Math.min(rect.width / W, rect.height / H)
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }
  }

  let scale = 1
  svg.addEventListener('wheel', (event) => {
    event.preventDefault()
    scale = Math.min(2.4, Math.max(0.5, scale * (event.deltaY > 0 ? 0.92 : 1.08)))
    zoom.setAttribute('transform', `translate(${(W * (1 - scale)) / 2} ${(H * (1 - scale)) / 2}) scale(${scale})`)
  }, { passive: false })

  let raf = null
  let ticks = 0
  const step = () => {
    ticks += 1
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        const dist = Math.hypot(dx, dy) || 0.01
        const minDist = a.r + b.r + (a.kind === 'domain' ? 80 : 40)
        const force = Math.min(1.6, (minDist * minDist) / (dist * dist)) * 0.5
        dx /= dist
        dy /= dist
        if (!a.fixed) { a.vx += dx * force; a.vy += dy * force }
        if (!b.fixed) { b.vx -= dx * force; b.vy -= dy * force }
      }
    }
    for (const { a, b } of edges) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.hypot(dx, dy) || 0.01
      const force = (dist - 130) * 0.004
      if (!a.fixed) { a.vx += (dx / dist) * force; a.vy += (dy / dist) * force }
      if (!b.fixed) { b.vx -= (dx / dist) * force; b.vy -= (dy / dist) * force }
    }
    for (const n of nodes) {
      if (n.fixed) continue
      n.vx += (W / 2 - n.x) * 0.0009
      n.vy += (H / 2 - n.y) * 0.0012
      n.vx *= 0.86
      n.vy *= 0.86
      n.x = clamp(n.x + n.vx, n.r + 30, W - n.r - 30)
      n.y = clamp(n.y + n.vy, n.r + 18, H - n.r - 18)
    }
    for (const { edge, el } of lines) {
      el.setAttribute('x1', edge.a.x.toFixed(1))
      el.setAttribute('y1', edge.a.y.toFixed(1))
      el.setAttribute('x2', edge.b.x.toFixed(1))
      el.setAttribute('y2', edge.b.y.toFixed(1))
    }
    for (const n of nodes) n.el.setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`)
    if (ticks < 360) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  state.graphHandle = { stop: () => { if (raf) cancelAnimationFrame(raf); state.graphHandle = null } }
}
function viewPlaceholder(title, text) {
  return `<div class="empty"><div><h3>${title}</h3><p class="dim" style="max-width:420px">${text}</p></div></div>`
}

function openRestoreDialog(name) {
  const modal = $('#modal')
  const body = $('#modal-body')
  $('#modal-title').textContent = `恢复 · ${name}`
  body.innerHTML = ''
  modal.hidden = false
  const close = () => { modal.hidden = true }

  const showModes = () => {
    $('#modal-title').textContent = `恢复 · ${name}`
    body.innerHTML = `
      <p class="dim">先选恢复方式，下一步还会再确认一次。</p>
      <div class="restore-modes">
        <button class="restore-mode" data-mode="merge">
          <b>增量恢复</b>
          <span>哈希相同的跳过，缺的补上，内容不同的覆盖，多余文件保留。适合补回丢失内容。</span>
        </button>
        <button class="restore-mode" data-mode="overwrite">
          <b>覆盖恢复</b>
          <span>镜像回滚：删除包里没有的文件，再写入包内文件。恢复前会自动备份当前库。</span>
        </button>
      </div>
      <div class="actions"><button class="btn" data-cancel>取消</button></div>`
    body.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.onclick = () => showConfirm(btn.dataset.mode)
    })
    body.querySelector('[data-cancel]').onclick = close
  }

  const showConfirm = (mode) => {
    const overwrite = mode === 'overwrite'
    $('#modal-title').textContent = overwrite ? '确认覆盖恢复' : '确认增量恢复'
    body.innerHTML = `
      <p>即将用 <code>${esc(name)}</code> 做${overwrite ? '覆盖' : '增量'}恢复。</p>
      <p class="dim">${overwrite
        ? '覆盖恢复会删除当前库里、备份包中没有的文件；恢复前会自动生成一份安全备份。'
        : '增量恢复只补缺失和内容不同的文件，不删除现有文件。'}</p>
      <div class="actions">
        <button class="btn primary" data-confirm>确定${overwrite ? '覆盖恢复' : '增量恢复'}</button>
        <button class="btn" data-back>返回上一步</button>
        <button class="btn" data-cancel>取消</button>
      </div>`
    body.querySelector('[data-back]').onclick = showModes
    body.querySelector('[data-cancel]').onclick = close
    const confirm = body.querySelector('[data-confirm]')
    confirm.onclick = async () => {
      confirm.disabled = true
      confirm.textContent = '恢复中…'
      try {
        const result = await api('/api/restore', { method: 'POST', body: JSON.stringify({ name, mode }) })
        close()
        await refreshAll()
        state.backups = await api('/api/backups')
        render()
        toast(`恢复完成：新建 ${result.created}，覆盖 ${result.updated}，删除 ${result.removed}`)
      } catch (error) {
        toast(error.message, true)
        confirm.disabled = false
        confirm.textContent = '重试'
      }
    }
  }

  showModes()
}
async function loadAuth() {
  const box = document.querySelector('#auth-body')
  if (!box) return
  try {
    const [codeInfo, authInfo] = await Promise.all([api('/api/pair/code'), api('/api/auth')])
    const locked = codeInfo.locked || authInfo.locked
    const tokenRows = (authInfo.tokens ?? []).length
      ? `<table class="mcp-table"><thead><tr><th>编号</th><th>名称</th><th>配对时间</th><th>最近使用</th><th>调用</th><th></th></tr></thead><tbody>${authInfo.tokens.map((tk) => `<tr><td><code>${esc(tk.id)}</code></td><td>${esc(tk.name)}</td><td>${esc(String(tk.createdAt).slice(0, 16).replace('T', ' '))}</td><td>${tk.lastUsedAt ? esc(String(tk.lastUsedAt).slice(0, 16).replace('T', ' ')) : '—'}</td><td>${tk.calls}</td><td><button class="btn small" data-revoke="${esc(tk.id)}">撤销</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="dim">还没有已配对的客户端。</p>'
    box.innerHTML = `
      <div class="auth-code ${locked ? 'locked' : ''}">${locked ? '已锁定' : esc(codeInfo.code)}</div>
      <p class="dim">${locked ? `尝试过多，锁定到 ${esc(codeInfo.lockedUntil ?? authInfo.lockedUntil ?? '')}` : '把配对码交给要写库的 Agent；重启后配对码和 token 一起失效。'}</p>
      ${tokenRows}
      <div class="actions"><button class="btn small" data-act="auth-refresh">刷新</button></div>`
    box.querySelector('[data-act="auth-refresh"]').onclick = loadAuth
    box.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api('/api/auth/revoke', { method: 'POST', body: JSON.stringify({ tokenId: btn.dataset.revoke }) })
          await loadAuth()
        } catch (error) { toast(error.message, true) }
      }
    })
  } catch (error) {
    box.textContent = `读取授权状态失败：${error.message}`
  }
}

function viewMcp() {
  // 直接打开 MCP 页（含刷新后还原）时，自己补一次加载
  if (!state.mcp) {
    loadMcpInfo().then(() => { if (state.view === 'mcp') render() }).catch(() => {})
  }
  const info = state.mcp ?? {}
  const tools = info.tools ?? []
  const endpoint = 'http://127.0.0.1:7788/mcp'
  return `
    <div class="settings">
      <h2>MCP</h2>
      <p class="dim">其他 Agent 用 JSON-RPC 连上来查库；写只到收件箱与待拍板，主库仍由人拍板。</p>

      <section class="set-card">
        <header><h3>开关</h3><p class="dim">默认关闭；未启动时「中断」不可点。</p></header>
        <div class="meta"><span class="mcp-status ${info.enabled ? 'on' : ''}">${info.enabled ? '运行中' : '已中断'}</span></div>
        <div class="actions">
          <button class="btn small primary" data-act="mcp-enable" ${info.enabled ? 'disabled' : ''}>启动 MCP</button>
          <button class="btn small" data-act="mcp-disable" ${info.enabled ? '' : 'disabled'}>中断 MCP</button>
        </div>
      </section>

      <section class="set-card">
        <header><h3>端点</h3><p class="dim">MCP ${esc(info.protocol ?? '')} ｜ ${info.readOnly ? '只读' : esc(`受限写：${info.writeScope ?? '未知范围'}`)}</p></header>
        <div class="meta"><code>${endpoint}</code></div>
        <div class="actions"><button class="btn small" data-act="copy-mcp">复制端点</button></div>
      </section>

      <section class="set-card" id="auth-card">
        <header><h3>配对授权</h3><p class="dim">写接口要配对；面板自己的写操作按同源放行。配对码重启即换，token 只存在内存里。</p></header>
        <div id="auth-body" class="dim">加载中…</div>
      </section>

      <section class="set-card">
        <header><h3>连接</h3><p class="dim">每个连接有编号与调用次数；操作记在 <code>_mcp/activity.jsonl</code></p></header>
        ${(info.sessions ?? []).length ? `
          <table class="mcp-table">
            <thead><tr><th>编号</th><th>客户端</th><th>调用</th><th>最近</th></tr></thead>
            <tbody>${info.sessions.map((s) => `<tr><td><code>${esc(s.editor)}</code></td><td>${esc(s.client)}</td><td>${s.calls}</td><td>${esc(String(s.lastSeen).slice(11, 19))}</td></tr>`).join('')}</tbody>
          </table>` : '<p class="dim">还没有 Agent 连上来。</p>'}
      </section>

      <section class="set-card">
        <header><h3>能做什么</h3><p class="dim">${tools.length} 个工具</p></header>
        ${tools.map((tool) => `
          <div class="mcp-tool">
            <b>${esc(tool.name)}</b>
            <p class="dim">${esc(tool.description)}</p>
          </div>`).join('')}
      </section>

      <section class="set-card">
        <header><h3>接法</h3><p class="dim">支持 HTTP MCP 的客户端，填端点就行。</p></header>
        <pre class="code-block">{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_consult","arguments":{"query":"BOM 启动失败"}}}</pre>
      </section>
    </div>`
}

function viewSettings() {
  const s = state.settings ?? {}
  const modes = [
    ['review', '审核', 'AI 只能提名，你点头才落盘。默认，也最稳。'],
    ['auto', '免审', '先进小经验区，攒够 10 条或 7 天再通知你。'],
    ['off', '关闭', '不自动生成，只手动记。'],
  ]
  const mode = modes.find(([id]) => id === (s.mode ?? 'review')) ? (s.mode ?? 'review') : 'review'
  const numField = (id, label, value, unit) => `
    <label class="num-field">
      <span>${label}</span>
      <span class="num-wrap"><input id="${id}" type="number" min="0" value="${value}" /><em>${unit}</em></span>
    </label>`
  return `
    <div class="settings">
      <h2>设置</h2>
      <p class="dim">只调三件事：经验怎么生成、多久打扰一次、数据放哪。</p>

      <section class="set-card">
        <header>
          <h3>经验生成</h3>
          <p class="dim">经验是"下次该怎么做"的判断，不是聊天记录。这里决定 AI 能不能自己写。</p>
        </header>
        <div class="mode-cards">
          ${modes.map(([id, name, desc]) => `
            <label class="mode-card ${mode === id ? 'picked' : ''}">
              <input type="radio" name="s-mode" value="${id}" ${mode === id ? 'checked' : ''} />
              <b>${name}</b><span>${desc}</span>
            </label>`).join('')}
        </div>
      </section>

      <section class="set-card">
        <header>
          <h3>打扰频率</h3>
          <p class="dim">审核模式下"每天问几次"；免审模式下"攒多少再提醒"。</p>
        </header>
        <div class="num-grid">
          ${numField('s-review-max', '审核：每天最多提议', s.review?.maxPerDay ?? 3, '条')}
          ${numField('s-cool', '审核：同主题冷却', s.review?.cooldownHours ?? 24, '小时')}
          ${numField('s-auto-max', '免审：每天最多写入', s.auto?.maxPerDay ?? 5, '条')}
          ${numField('s-notify-every', '免审：攒够几条通知', s.auto?.notifyEvery ?? 10, '条')}
          ${numField('s-notify-days', '免审：隔几天通知', s.auto?.notifyAfterDays ?? 7, '天')}
        </div>
      </section>

      <section class="set-card">
        <header>
          <h3>数据与备份</h3>
          <p class="dim">整库打包；恢复分「增量」和「覆盖」，点恢复后还要再确认一次。</p>
        </header>
        <div class="meta"><span>数据目录：<code>${esc(state.overview?.home ?? '')}</code></span></div>
        <div class="actions">
          <button class="btn" data-act="repair">重建索引 / 修复映射</button>
        </div>
        <div class="backup-opts">
          <label><input type="checkbox" id="bk-trash" checked /> 包含回收站</label>
          <label><input type="checkbox" id="bk-index" checked /> 包含索引</label>
          <label>保留最近 <input id="bk-keep" type="number" min="0" max="50" value="5" /> 个</label>
          <button class="btn primary" data-act="backup-now">立即备份</button>
        </div>
        <div class="backup-list">
          ${(state.backups ?? []).length
            ? state.backups.map((b) => `
              <div class="backup-row">
                <div class="backup-meta">
                  <b>${esc(b.name)}</b>
                  <span class="dim">${(b.bytes / 1024).toFixed(0)} KB · ${esc(String(b.mtime).slice(0, 16).replace('T', ' '))}</span>
                </div>
                <button class="btn small" data-restore="${esc(b.name)}">恢复</button>
              </div>`).join('')
            : '<p class="dim">还没有备份包，点「立即备份」生成一个。</p>'}
        </div>
      </section>

      <div class="savebar">
        <span class="dim">改完记得保存。</span>
        <button class="btn primary" data-act="save-settings">保存设置</button>
      </div>
    </div>`
}

// ---------- 交互 ----------

function currentDetailId() {
  return state.detail?.id ?? null
}

// ---------- 界面状态记忆（下次打开还原上次的样子）----------

const UI_KEY = 'kb:ui-v1'

function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || 'null') } catch { return null }
}

function saveUi() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({
      view: state.view,
      expTab: state.expTab,
      collapsed: [...state.collapsed],
      indexMode: state.indexMode,
      detail: state.detail ? { id: state.detail.id, type: state.detail.type } : null,
      scroll: document.querySelector('.listpane')?.scrollTop ?? 0,
    }))
  } catch { /* 隐私模式写不了就忽略 */ }
}

async function refreshAll() {
  await Promise.all([loadOverview(), loadExperiences(), loadProposals()])
  if (state.view === 'kb') await loadBlocks()
  render()
}

function readForm() {
  const patch = {}
  const map = {
    'f-title': 'title', 'f-summary': 'summary', 'f-source': 'source', 'f-body': 'body',
    'f-claim': 'claim', 'f-scope': 'scope', 'f-limits': 'limits',
    'f-kind': 'kind', 'f-tags': 'tags',
  }
  for (const [id, key] of Object.entries(map)) {
    const node = document.getElementById(id)
    if (node) patch[key] = node.value
  }
  return patch
}

async function saveDetail() {
  if (!state.detail) return
  const patch = readForm()
  const saved = await api(`/api/blocks/${encodeURIComponent(state.detail.id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  state.detail = saved
  toast('已保存')
  await refreshAll()
}

async function expAction(action, extra = {}) {
  if (!state.detail) return
  const data = await api(`/api/experiences/${encodeURIComponent(state.detail.id)}/action`, {
    method: 'POST', body: JSON.stringify({ action, ...extra }),
  })
  state.detail = data
  toast('已记录')
  await refreshAll()
}

async function deleteDetail() {
  if (!state.detail) return
  if (!confirm(`删除「${state.detail.title}」？会进回收站，不物理删除。`)) return
  const res = await api(`/api/blocks/${encodeURIComponent(state.detail.id)}`, { method: 'DELETE' })
  toast(res.orphaned?.length ? `已删除；${res.orphaned.length} 条经验转为孤儿` : '已删除')
  state.detail = null
  await refreshAll()
}

function openForm({ title, fields, submit = '确定', onSubmit }) {
  $('#modal-title').textContent = title
  $('#modal-body').innerHTML = fields.map((f) => `
    <div class="field">
      <label>${esc(f.label)}</label>
      ${f.type === 'textarea'
        ? `<textarea id="mf-${f.key}" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea>`
        : f.type === 'select'
          ? `<select id="mf-${f.key}">${(f.options ?? []).map(([value, label]) => `<option value="${esc(value)}" ${f.value === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`
          : `<input id="mf-${f.key}" type="text" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" />`}
    </div>`).join('') + `<div class="actions"><button class="btn primary" id="mf-go">${esc(submit)}</button></div>`
  $('#modal').hidden = false
  setTimeout(() => document.getElementById(`mf-${fields[0].key}`)?.focus(), 30)
  $('#mf-go').onclick = async () => {
    const values = {}
    for (const f of fields) values[f.key] = (document.getElementById(`mf-${f.key}`)?.value ?? '').trim()
    try {
      await onSubmit(values)
      $('#modal').hidden = true
    } catch (error) {
      toast(error.message, true)
    }
  }
}

function openProposalModal() {
  const rows = state.proposals
  const actionText = { new: '新建经验', merge: '融合', transplant: '跨域派生', refute: '推翻', promote: '转正' }
  $('#modal-title').textContent = `待拍板（${rows.length}）`
  $('#modal-body').innerHTML = rows.length ? rows.map((p) => {
    const payload = p.payload ?? {}
    const claim = payload.claim ?? payload.id ?? ''
    const yesText = p.action === 'refute' ? '同意推翻' : p.action === 'promote' ? '同意转正' : '同意'
    return `
      <div class="card">
        <div class="head"><span class="tag ok">${esc(actionText[p.action] ?? p.action)}</span><span class="claim">${esc(claim)}</span></div>
        <div class="why">AI 的理由：${esc(p.reason || '（没写）')}</div>
        <div class="actions">
          <button class="btn small primary" data-decide="${p.seq}" data-yes="1" onclick="window.__kbDecide && window.__kbDecide(${p.seq}, true)">${yesText}</button>
          <button class="btn small" data-decide="${p.seq}" data-yes="0" onclick="window.__kbDecide && window.__kbDecide(${p.seq}, false)">否决</button>
          ${p.action === 'new' || p.action === 'merge' ? `<button class="btn small" data-rewrite="${p.seq}">改一下再同意</button>` : ''}
        </div>
      </div>`
  }).join('') : '<p class="dim">没有待拍板的提议。</p>'
  // 弹窗内容是动态生成的，事件要在这里绑；只靠 bind() 时那批按钮会是死的
  $('#modal-body').querySelectorAll('[data-decide]').forEach((btn) => {
    btn.onclick = async () => {
      try { await decideProposal(Number(btn.dataset.decide), btn.dataset.yes === '1') } catch (error) { toast(error.message, true) }
    }
  })
  $('#modal-body').querySelectorAll('[data-rewrite]').forEach((btn) => {
    btn.onclick = () => {
      const seq = Number(btn.dataset.rewrite)
      openForm({
        title: '改一下再同意',
        submit: '按我的版本接受',
        fields: [{ key: 'claim', label: '改成什么？' }],
        onSubmit: async (v) => { await decideProposal(seq, true, v.claim) },
      })
    }
  })
  $('#modal').hidden = false
}

async function decideProposal(seq, yes, claim) {
  await api(`/api/proposals/${seq}/decide`, { method: 'POST', body: JSON.stringify({ yes, claim }) })
  toast(yes ? '已接受' : '已否决')
  await refreshAll()
  openProposalModal()
}

function bind() {
  // 导航
  document.querySelectorAll('#nav button[data-view]').forEach((btn) => {
    btn.onclick = () => switchView(btn.dataset.view)
  })

  // 设置：模式卡片点选后高亮跟着走
  document.querySelectorAll('input[name="s-mode"]').forEach((el) => {
    el.onchange = () => {
      document.querySelectorAll('.mode-card').forEach((card) => {
        card.classList.toggle('picked', !!card.querySelector('input')?.checked)
      })
    }
  })

  const search = $('#search-input')
  if (search) {
    let timer = null
    search.oninput = () => {
      state.q = search.value
      clearTimeout(timer)
      timer = setTimeout(async () => { await loadBlocks(); render() }, 220)
    }
  }
  const filter = $('#domain-filter')
  if (filter) {
    filter.onchange = async () => {
      state.domain = filter.value
      await loadBlocks()
      render()
    }
  }

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => { state.expTab = btn.dataset.tab; state.detail = null; render(); saveUi() }
  })

  document.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.onclick = () => openRestoreDialog(btn.dataset.restore)
  })
  document.querySelectorAll('[data-graph-crumb]').forEach((node) => {
    node.onclick = () => { state.graphPath = (state.graphPath ?? []).slice(0, Number(node.dataset.graphCrumb)); render() }
  })
  document.querySelectorAll('[data-graph-back]').forEach((node) => {
    node.onclick = () => { state.graphPath = (state.graphPath ?? []).slice(0, -1); render() }
  })
  document.querySelectorAll('[data-index-mode]').forEach((node) => {
    node.onclick = () => { state.indexMode = node.dataset.indexMode; render() }
  })
  document.querySelectorAll('[data-index-node]').forEach((node) => {
    node.onclick = () => { state.indexPath = String(node.dataset.indexNode).split('/').filter(Boolean); render() }
  })
  document.querySelectorAll('[data-index-crumb]').forEach((node) => {
    node.onclick = () => { state.indexPath = state.indexPath.slice(0, Number(node.dataset.indexCrumb)); render() }
  })

  document.querySelectorAll('[data-open]').forEach((node) => {
    node.onclick = async (event) => {
      if (event.target.closest('[data-act]')) return
      const id = node.dataset.open
      // 从索引/经验页点进来时，先切回知识库视图，再开详情
      if (state.view !== 'kb') {
        state.view = 'kb'
        state.detail = null
        await loadBlocks()
      }
      await openBlock(id)
    }
  })

  document.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act
      try {
        if (act === 'back') { state.detail = null; render(); saveUi(); return }
        if (act === 'backup-now') {
          const body = JSON.stringify({
            includeTrash: document.querySelector('#bk-trash')?.checked !== false,
            includeIndex: document.querySelector('#bk-index')?.checked !== false,
            keep: Number(document.querySelector('#bk-keep')?.value ?? 0),
          })
          const result = await api('/api/backup', { method: 'POST', body })
          state.backups = await api('/api/backups')
          render()
          const pruned = result.pruned?.length ? `，清理 ${result.pruned.length} 个旧包` : ''
          return toast(`已备份 ${result.files} 个文件${pruned}`)
        }
        if (act === 'mcp-enable' || act === 'mcp-disable') {
          const enable = act === 'mcp-enable'
          const data = await api(enable ? '/api/mcp/enable' : '/api/mcp/disable', { method: 'POST', body: '{}' })
          state.mcp = data
          render()
          return toast(enable ? 'MCP 已启动' : 'MCP 已中断')
        }
        if (act === 'copy-mcp') {
          try { await navigator.clipboard.writeText('http://127.0.0.1:7788/mcp') } catch { /* 忽略 */ }
          return toast('MCP 端点已复制')
        }
        if (act === 'copy-id') {
          try { await navigator.clipboard.writeText(btn.dataset.id) } catch { /* 剪贴板不可用时忽略 */ }
          return toast(`已复制 ${btn.dataset.id}`)
        }
        if (act === 'delete-id') {
          const title = btn.dataset.title || btn.dataset.id
          if (!window.confirm(`删除「${title}」？会进回收站，可恢复。`)) return
          await api(`/api/blocks/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' })
          toast('已删除（进回收站）')
          return refreshAll()
        }
        if (act === 'focus-search') { document.getElementById('search-input')?.focus(); return }
        if (act === 'goto-index') return switchView('index')
        if (act === 'toggle-group') {
          const group = btn.dataset.group
          if (state.collapsed.has(group)) state.collapsed.delete(group)
          else state.collapsed.add(group)
          render(); saveUi(); return
        }
        if (act === 'sphere-back') return await sphereBack()
        if (act === 'new') return openNewKnowledge()
        if (act === 'new-exp') return openNewExperience()
        if (act === 'save') return await saveDetail()
        if (act === 'delete') return await deleteDetail()
        if (act === 'refine') {
          return openForm({
            title: '追加补充',
            submit: '补充',
            fields: [{ key: 'note', label: '补了什么？（新条件、新证据、边界）', type: 'textarea' }],
            onSubmit: async (v) => { await expAction('refine', { note: v.note }) },
          })
        }
        if (act === 'apply-success') return await expAction('apply', { result: 'success' })
        if (act === 'apply-failure') return await expAction('apply', { result: 'failure' })
        if (act === 'hit') return await expAction('hit')
        if (act === 'vote-up') return await expAction('vote', { value: 1 })
        if (act === 'vote-down') return await expAction('vote', { value: -1 })
        if (act === 'pin') return await expAction('pin', { on: !state.detail?.accounting?.pinned })
        if (act === 'promote') return await expAction('promote')
        if (act === 'refute') {
          return openForm({
            title: '推翻这条经验',
            submit: '推翻',
            fields: [
              { key: 'by', label: '反证是什么？（id 或一句话）' },
              { key: 'note', label: '补充说明（可留空）', type: 'textarea' },
            ],
            onSubmit: async (v) => { await expAction('refute', { by: v.by, note: v.note }) },
          })
        }
        if (act === 'merge') return await openMergeModal()
        if (act === 'transplant') return await openTransplantModal()
        if (act === 'repair') {
          const report = await api('/api/repair', { method: 'POST', body: '{}' })
          toast(`重建完成：收编 ${report.adopted.length}，重映射 ${report.remapped.length}，孤儿 ${report.orphaned.length}`)
          return await refreshAll()
        }
        if (act === 'save-settings') return await saveSettings()
      } catch (error) {
        toast(error.message, true)
      }
    }
  })

  document.querySelectorAll('[data-act="toggle-group"]').forEach((el) => {
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        el.click()
      }
    })
  })

  document.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.onclick = async () => {
      try { await decideProposal(Number(btn.dataset.decide), btn.dataset.yes === '1') } catch (error) { toast(error.message, true) }
    }
  })
  document.querySelectorAll('[data-rewrite]').forEach((btn) => {
    btn.onclick = async () => {
      const seq = Number(btn.dataset.rewrite)
      openForm({
        title: '改一下再要',
        submit: '按我的版本接受',
        fields: [{ key: 'claim', label: '改成什么？' }],
        onSubmit: async (v) => { await decideProposal(seq, true, v.claim) },
      })
    }
  })

  document.querySelectorAll('[data-sphere-pick]').forEach((btn) => {
    btn.onclick = () => {
      const node = state.sphereNodes.find((n) => n.id === btn.dataset.spherePick)
      if (node) pickSphereNode(node)
    }
  })

  document.querySelectorAll('[data-toc]').forEach((btn) => {
    btn.onclick = () => {
      const area = document.getElementById('f-body')
      if (!area) return
      const offset = Number(btn.dataset.toc)
      const length = Number(btn.dataset.tocLen) || 0
      area.focus()
      area.setSelectionRange(offset, offset + length)
      const line = area.value.slice(0, offset).split('\n').length - 1
      const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 20
      area.scrollTop = Math.max(0, line * lineHeight - 40)
    }
  })
}

const BODY_TEMPLATES = {
  concept: '## 定义\n\n## 原理\n\n## 边界\n',
  howto: '## 前置\n\n## 步骤\n\n1. \n\n## 结果\n',
  troubleshoot: '## 症状\n\n## 可能原因\n\n## 修复\n\n## 还不行怎么办\n',
  reference: '## 参数\n\n| 名称 | 说明 |\n|---|---|\n|  |  |\n',
  tutorial: '## 你将学会\n\n## 准备\n\n## 步骤\n\n## 检查\n',
  decision: '## 背景\n\n## 选项\n\n## 决定\n\n## 后果\n',
  code: '## 用途\n\n## 代码\n\n```\n\n```\n\n## 依赖\n',
  faq: '## 问题\n\n## 回答\n',
}

async function openNewKnowledge() {
  openForm({
    title: '新建知识',
    submit: '创建',
    fields: [
      { key: 'title', label: '标题' },
      { key: 'domain', label: '领域', value: 'default' },
      { key: 'kind', label: '类型', type: 'select', value: 'concept', options: KNOWLEDGE_KINDS },
      { key: 'tags', label: '标签（逗号分隔，可留空）' },
      { key: 'summary', label: '简介（可留空，索引层用）' },
      { key: 'body', label: '正文（按类型自动带骨架）', type: 'textarea', value: BODY_TEMPLATES.concept },
    ],
    onSubmit: async (v) => {
      if (!v.title) throw new Error('标题必填')
      const created = await api('/api/blocks', { method: 'POST', body: JSON.stringify(v) })
      await refreshAll()
      await openBlock(created.id)
      toast('已创建')
    },
  })
}

async function openNewExperience() {
  openForm({
    title: '记一条经验',
    submit: '记下',
    fields: [
      { key: 'claim', label: '一句话判断（要能拿来用）' },
      { key: 'domain', label: '领域', value: 'default' },
      { key: 'scope', label: '适用范围（可留空）' },
    ],
    onSubmit: async (v) => {
      if (!v.claim) throw new Error('判断不能为空')
      const res = await api('/api/experiences', { method: 'POST', body: JSON.stringify(v) })
      await refreshAll()
      await openBlock(res.id)
      toast('已记下')
    },
  })
}

async function openMergeModal() {
  const others = state.experiences.filter((e) => e.id !== state.detail?.id && e.status !== 'refuted')
  const options = others.map((e) => `<option value="${esc(e.id)}">${esc(e.claim)}</option>`).join('')
  $('#modal-title').textContent = '融合'
  $('#modal-body').innerHTML = `
    <div class="field"><label>与哪条融合</label><select id="m-other">${options}</select></div>
    <div class="field"><label>融合后的判断</label><input id="m-claim" type="text" placeholder="一句话" /></div>
    <div class="field"><label>出生领域（解决的那个问题在哪）</label><input id="m-domain" type="text" value="${esc(state.detail?.domain ?? 'default')}" /></div>
    <button class="btn primary" id="m-go">融合</button>`
  $('#modal').hidden = false
  $('#m-go').onclick = async () => {
    try {
      const res = await api('/api/merge', {
        method: 'POST',
        body: JSON.stringify({
          a: state.detail.id,
          b: $('#m-other').value,
          claim: $('#m-claim').value.trim(),
          domain: $('#m-domain').value.trim(),
        }),
      })
      $('#modal').hidden = true
      toast(`已融合：${res.id}`)
      await refreshAll()
      await openBlock(res.id)
    } catch (error) { toast(error.message, true) }
  }
}

async function openTransplantModal() {
  $('#modal-title').textContent = '跨域派生'
  $('#modal-body').innerHTML = `
    <div class="field"><label>目标领域</label><input id="t-domain" type="text" placeholder="例如 化学" /></div>
    <div class="field"><label>派生出来的判断（可留空沿用原判断）</label><input id="t-claim" type="text" /></div>
    <button class="btn primary" id="t-go">派生</button>`
  $('#modal').hidden = false
  $('#t-go').onclick = async () => {
    try {
      const res = await api('/api/transplant', {
        method: 'POST',
        body: JSON.stringify({ id: state.detail.id, domain: $('#t-domain').value.trim(), claim: $('#t-claim').value.trim() || undefined }),
      })
      $('#modal').hidden = true
      toast(`已派生到「${res.domain}」`)
      await refreshAll()
      await openBlock(res.id)
    } catch (error) { toast(error.message, true) }
  }
}

async function saveSettings() {
  const num = (id, fallback) => {
    const v = Number(document.getElementById(id)?.value)
    return Number.isFinite(v) ? v : fallback
  }
  const experience = {
    mode: document.querySelector('input[name="s-mode"]:checked')?.value ?? 'review',
    review: { maxPerDay: num('s-review-max', 3), cooldownHours: num('s-cool', 24) },
    auto: { notifyEvery: num('s-notify-every', 10), notifyAfterDays: num('s-notify-days', 7), maxPerDay: num('s-auto-max', 5) },
  }
  state.settings = await api('/api/settings', { method: 'POST', body: JSON.stringify({ experience }) })
  toast('设置已保存')
  render()
}

// ---------- 命令面板（Ctrl+K） ----------

const paletteState = { index: 0, items: [], q: '' }

function paletteCommands() {
  return [
    { label: '新建知识', hint: 'N', run: () => openNewKnowledge() },
    { label: '记一条经验', run: () => openNewExperience() },
    { label: '看待拍板的提议', run: () => openProposalModal() },
    { label: '去知识库', run: () => switchView('kb') },
    { label: '去经验块', run: () => switchView('exp') },
    { label: '去索引', run: () => switchView('index') },
    { label: '去设置', run: () => switchView('settings') },
    {
      label: '重建索引 / 修映射',
      run: async () => {
        const report = await api('/api/repair', { method: 'POST', body: '{}' })
        toast(`重建完成：收编 ${report.adopted.length}，重映射 ${report.remapped.length}，孤儿 ${report.orphaned.length}`)
        await refreshAll()
      },
    },
  ]
}

async function switchView(view) {
  state.view = view
  state.detail = null
  saveUi()
  if (view === 'kb') await loadBlocks()
  if (view === 'exp') await loadExperiences()
  if (view === 'index') await loadBlocks()
  if (view === 'mcp') await loadMcpInfo()
  if (view === 'settings') await loadBackups()
  render()
}

// ---------- 三维索引 ----------

async function loadBackups() {
  try { state.backups = await api('/api/backups') } catch { state.backups = [] }
}

async function loadMcpInfo() {
  try {
    state.mcp = await api('/api/mcp-info')
    window.__mcpDebug = state.mcp
  } catch (error) {
    window.__mcpDebug = 'ERR ' + error.message
    throw error
  }
}

async function loadSphereData() {
  if (state.sphereLevel === 'domains') {
    const tree = state.overview?.tree ?? []
    state.sphereNodes = (tree.length ? tree : (state.overview?.domains ?? []).map((d) => ({ name: d.domain, path: d.domain, count: d.n })))
      .map((d) => ({
        id: `domain:${d.path ?? d.domain}`,
        label: d.name ?? d.domain,
        kind: 'domain',
        weight: d.count ?? d.n,
      }))
    return
  }
  const rows = await api(`/api/blocks?domain=${encodeURIComponent(state.sphereDomain)}&limit=120`)
  state.sphereNodes = rows.map((row) => ({
    id: row.id,
    label: row.title,
    kind: row.type,
    weight: row.type === 'experience' ? 3 : 1,
  }))
}

function mountSphere() {
  const stage = document.getElementById('sphere')
  if (!stage) return
  state.sphereHandle = createSphere(stage, state.sphereNodes, { onPick: pickSphereNode })
}

async function pickSphereNode(node) {
  if (node.kind === 'domain') {
    state.sphereLevel = 'blocks'
    state.sphereDomain = node.label
    await loadSphereData()
    render()
    return
  }
  await switchView(node.kind === 'experience' ? 'exp' : 'kb')
  await openBlock(node.id)
}

async function sphereBack() {
  state.sphereLevel = 'domains'
  state.sphereDomain = ''
  await loadSphereData()
  render()
}

async function openPalette() {
  $('#palette').hidden = false
  paletteState.q = ''
  paletteState.index = 0
  const input = $('#palette-input')
  input.value = ''
  input.focus()
  await refreshPalette()
}

function closePalette() {
  $('#palette').hidden = true
}

async function refreshPalette() {
  const q = paletteState.q.trim()
  let blocks = []
  if (q) {
    try { blocks = await api(`/api/blocks?q=${encodeURIComponent(q)}&limit=8`) } catch { blocks = [] }
  }
  paletteState.items = [
    ...blocks.map((b) => ({
      label: b.title,
      sub: `${b.domain} · ${b.type === 'experience' ? '经验' : '知识'}`,
      run: async () => {
        await switchView(b.type === 'experience' ? 'exp' : 'kb')
        await openBlock(b.id)
      },
    })),
    ...paletteCommands().filter((c) => !q || c.label.includes(q)),
  ]
  paletteState.index = 0
  renderPalette()
}

function renderPalette() {
  const list = $('#palette-list')
  if (!paletteState.items.length) {
    list.innerHTML = '<p class="dim" style="padding:14px">没有匹配</p>'
    return
  }
  list.innerHTML = paletteState.items.map((it, i) => `
    <div class="palette-item ${i === paletteState.index ? 'active' : ''}" data-i="${i}">
      <span>${esc(it.label)}</span>
      ${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}
      ${it.hint ? `<span class="k">${esc(it.hint)}</span>` : ''}
    </div>`).join('')
  list.querySelectorAll('[data-i]').forEach((node) => {
    node.onclick = () => runPaletteItem(Number(node.dataset.i))
  })
}

async function runPaletteItem(index) {
  const item = paletteState.items[index]
  if (!item) return
  closePalette()
  try { await item.run() } catch (error) { toast(error.message, true) }
}

// ---------- 启动 ----------

async function boot() {
  try {
    const saved = loadUi()
    if (saved?.view) state.view = saved.view
    if (saved?.expTab) state.expTab = saved.expTab
    if (saved?.indexMode === 'graph' || saved?.indexMode === 'treemap') state.indexMode = saved.indexMode
    if (Array.isArray(saved?.collapsed)) state.collapsed = new Set(saved.collapsed)

    await loadOverview()
    await loadBlocks()
    await loadExperiences()
    await loadProposals()

    // 第一次打开：文件夹全部折叠，别一下摊开一地
    if (!saved) {
      const tops = new Set(state.blocks.map((b) => String(b.domain ?? '').split('/')[0]).filter(Boolean))
      state.collapsed = tops
    }
    // 还原上次打开的那一条
    if (saved?.detail?.id) {
      try { await openBlock(saved.detail.id) } catch { /* 那条被删了就跳过 */ }
    }

    render()
    bind()
    if (saved?.scroll) {
      const listpane = document.querySelector('.listpane')
      if (listpane) listpane.scrollTop = saved.scroll
    }
    const listpane = document.querySelector('.listpane')
    if (listpane) {
      let timer = null
      listpane.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(saveUi, 300) })
    }
    $('#modal-close').onclick = () => { $('#modal').hidden = true }
    $('#modal').onclick = (event) => { if (event.target.id === 'modal') $('#modal').hidden = true }
    $('#btn-proposals').onclick = () => openProposalModal()
    // 内联 onclick 用：不再依赖动态节点的事件绑定
    window.__kbDecide = (seq, yes) => decideProposal(seq, yes).catch((error) => toast(error.message, true))
    // 弹窗按钮用事件委托：内容动态生成，逐次绑定容易漏
    document.addEventListener('click', (event) => {
      const btn = event.target.closest?.('[data-decide]')
      if (!btn) return
      event.preventDefault()
      decideProposal(Number(btn.dataset.decide), btn.dataset.yes === '1')
        .catch((error) => toast(error.message, true))
    })
    // 从挂件/外链带 ?proposals=1 进来时，直接把待拍板打开
    if (new URLSearchParams(location.search).get('proposals') === '1') openProposalModal()

    const paletteInput = $('#palette-input')
    paletteInput.oninput = async () => {
      paletteState.q = paletteInput.value
      await refreshPalette()
    }
    paletteInput.onkeydown = async (event) => {
      if (event.key === 'Escape') return closePalette()
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        paletteState.index = Math.min(paletteState.index + 1, Math.max(0, paletteState.items.length - 1))
        return renderPalette()
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        paletteState.index = Math.max(paletteState.index - 1, 0)
        return renderPalette()
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        await runPaletteItem(paletteState.index)
      }
    }
    $('#palette').onclick = (event) => { if (event.target.id === 'palette') closePalette() }
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
        event.preventDefault()
        document.getElementById('search-input')?.focus()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openPalette()
      } else if (event.key === 'Escape') {
        if (!$('#palette').hidden) closePalette()
        else if (!$('#modal').hidden) $('#modal').hidden = true
      }
    })
  } catch (error) {
    $('#main').innerHTML = `<div class="empty"><div><h3>连不上本地服务</h3><p class="dim">${esc(error.message)}</p></div></div>`
  }
}

boot()


























