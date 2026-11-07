/**
 * 知识库视图：分区树 + 列表 + 详情。纯渲染，不绑定事件。
 */
import { state, esc, fmt, typeTag, KNOWLEDGE_KINDS, crumbs } from '../shared.js'
import { expDetailHtml } from './experience.js'
function groupBlocks(rows) {
  const tree = state.overview?.tree ?? []
  const totalMap = new Map((state.overview?.domains ?? []).map((d) => [d.domain, d.n]))
  const byDomain = new Map()
  for (const row of rows) {
    if (!byDomain.has(row.domain)) byDomain.set(row.domain, [])
    byDomain.get(row.domain).push(row)
  }
  const build = (path, name) => {
    const items = byDomain.get(path) ?? []
    return {
      domain: path,
      name,
      items,
      total: totalMap.get(path) ?? items.length,
      children: [],
    }
  }
  const groups = []
  const seen = new Set()
  for (const top of tree) {
    const node = build(top.path, top.name)
    for (const child of top.children ?? []) {
      const childNode = build(child.path, child.name)
      if (childNode.items.length || childNode.total) node.children.push(childNode)
      seen.add(child.path)
    }
    node.total = (node.total ?? 0) + node.children.reduce((sum, child) => sum + child.total, 0)
    if (node.items.length || node.children.length || node.total) groups.push(node)
    seen.add(top.path)
  }
  // 不在树里的分区（理论上不会有）兜底
  for (const [domain, items] of byDomain) {
    if (seen.has(domain)) continue
    groups.push({ domain, name: domain, items, total: items.length, children: [] })
  }
  return groups
}

export function viewKb() {
  const domains = state.overview?.domains ?? []
  const tree = state.overview?.tree ?? []
  const domainOptions = tree.length
    ? ['<option value="">全部分区</option>',
       ...tree.flatMap((t) => [
         `<option value="${esc(t.path)}" ${state.domain === t.path ? 'selected' : ''}>${esc(t.name)} (${t.count})</option>`,
         ...t.children.map((c) => `<option value="${esc(c.path)}" ${state.domain === c.path ? 'selected' : ''}>　${esc(c.name)} (${c.count})</option>`),
       ])].join('')
    : ['<option value="">全部分区</option>',
       ...domains.map((d) => `<option value="${esc(d.domain)}" ${state.domain === d.domain ? 'selected' : ''}>${esc(d.domain)} (${d.n})</option>`)].join('')

  const rowHtml = (row, showDomain) => `
    <div class="row ${state.detail?.id === row.id ? 'active' : ''}" data-open="${esc(row.id)}">
      <div class="t">${typeTag(row)}<span class="title">${esc(row.title)}</span></div>
      <div class="sub">${showDomain ? `${esc(row.domain)} ｜ ` : ''}${esc(row.summary || '（无简介）')}</div>
      <div class="row-actions">
        <button class="mini" title="复制 id" data-act="copy-id" data-id="${esc(row.id)}">⧉</button>
        <button class="mini danger" title="删除" data-act="delete-id" data-id="${esc(row.id)}" data-title="${esc(row.title)}">✕</button>
      </div>
    </div>`

  const groups = groupBlocks(state.blocks)
  const totalMap = new Map(domains.map((d) => [d.domain, d.n]))
  const loadedCount = (g) => g.items.length + g.children.reduce((sum, child) => sum + loadedCount(child), 0)
  const countText = (g) => {
    const total = g.total ?? totalMap.get(g.domain) ?? loadedCount(g)
    const loaded = loadedCount(g)
    if (!total || loaded >= total) return String(loaded)
    return `${loaded}/${total}`
  }

  const groupHtml = (g, depth = 0) => {
    const collapsed = state.collapsed.has(g.domain)
    const head = `
      <div class="group-head ${depth ? 'sub' : ''}" role="treeitem" aria-expanded="${!collapsed}"
           tabindex="0" data-act="toggle-group" data-group="${esc(g.domain)}">
        <span class="chev">${collapsed ? '▸' : '▾'}</span>
        <span class="gname">${esc(g.name)}</span>
        <span class="count">${countText(g)}</span>
      </div>`
    if (collapsed) return `<div class="group">${head}</div>`
    const children = g.children.map((child) => groupHtml(child, depth + 1)).join('')
    const rows = g.items.map((row) => rowHtml(row, false)).join('')
    return `<div class="group">${head}<div class="group-body" role="group">${children}${rows}</div></div>`
  }

  const list = state.blocks.length
    ? groups.map((g) => groupHtml(g)).join('')
    : '<div class="empty small"><h3>还没有内容</h3><p class="dim">点上面「新建知识」，或把资料拖进 ingest。</p></div>'

  const warnings = state.warnings.length ? `
    <div class="warn-box">
      <div class="warn-head">⚠ 反例 ${state.warnings.length} 条（不占正文名额）</div>
      ${state.warnings.map((w) => `
        <div class="warn-item" data-open="${esc(w.id)}">
          <div class="claim">${esc(w.claim)}</div>
          <div class="why">被 ${esc(w.refuted_by.join(', ') || '（未填）')} 推翻${w.domain ? ` ｜ ${esc(w.domain)}` : ''}</div>
        </div>`).join('')}
    </div>` : ''

  return `
    <div class="split ${state.detail ? 'has-detail' : ''}">
      <section class="listpane">
        <div class="toolbar">
          <input id="search-input" type="search" placeholder="搜索（两字词也行）" value="${esc(state.q)}" />
          <select id="domain-filter">
            ${domainOptions}
          </select>
        </div>
        <button class="btn primary" style="width:100%;margin-bottom:10px" data-act="new">+ 新建知识</button>
        <div>${list}</div>
        ${warnings}
      </section>
      <section class="detail">${state.detail ? detailHtml(state.detail) : `
        <div class="empty hero">
          <div class="hero-mark">✦</div>
          <h3>从一条知识开始</h3>
          <p class="dim">左边选一条，或按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 搜全库。</p>
          <div class="hero-actions">
            <button class="btn primary" data-act="new">+ 新建知识</button>
            <button class="btn" data-act="focus-search">搜索</button>
            <button class="btn" data-act="goto-index">看索引</button>
          </div>
        </div>`}</section>
    </div>`
}

function detailHtml(d) {
  if (d.type === 'experience') return expDetailHtml(d)
  const outline = d.outline ?? []
  const toc = outline.length ? `
    <div class="toc">
      <div class="toc-head">目录 ${outline.length} 节</div>
      ${outline.map((item) => `<button class="toc-item l${item.level}" data-toc="${item.offset}" data-toc-len="${item.title.length}">${esc(item.title)}</button>`).join('')}
    </div>` : ''
  return `
    <header class="detail-head">
      <button class="btn small back" data-act="back">← 返回</button>
      <div class="crumb">${crumbs(d.domain)}</div>
      <h2 class="detail-title">${esc(d.title)}</h2>
      <div class="meta">
        <span><code>${esc(d.id)}</code></span>
        <span class="tag">${esc((KNOWLEDGE_KINDS.find((k) => k[0] === d.kind) ?? ['', d.kind])[1] || '概念')}</span>
        <span>v${d.version}</span>
        <span>${esc(d.status)}</span>
        <span>改于 ${fmt(d.modified_at)}</span>
        ${d.orphaned ? '<span class="tag warn">孤儿</span>' : ''}
      </div>
    </header>
    ${toc}
    <div class="field"><label>标题</label><input id="f-title" type="text" value="${esc(d.title)}" /></div>
    <div class="field"><label>简介（索引层用，≤200 字）</label><input id="f-summary" type="text" value="${esc(d.summary)}" /></div>
    <div class="field">
      <label>类型</label>
      <select id="f-kind">
        ${KNOWLEDGE_KINDS.map(([value, label]) => `<option value="${value}" ${d.kind === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>标签（逗号分隔）</label><input id="f-tags" type="text" value="${esc((d.tags ?? []).join(', '))}" /></div>
    <div class="field"><label>来源</label><input id="f-source" type="text" value="${esc(d.source)}" /></div>
    <div class="field"><label>正文（Markdown，用 ## / ### 组织目录）</label><textarea id="f-body" style="min-height:300px">${esc(d.body)}</textarea></div>
    <div class="actions">
      <button class="btn primary" data-act="save">保存</button>
      <button class="btn" data-act="refine">追加补充</button>
      <button class="btn danger" data-act="delete">删除（进回收站）</button>
    </div>`
}


