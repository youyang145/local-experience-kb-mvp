/**
 * 面板共享层：全局状态、DOM/格式化小工具、通用标签。
 *
 * 约定：视图只从这里取 state 和纯函数；请求走 api.js；不要在视图里直接 fetch。
 */

export const state = {
  view: 'kb',
  overview: null,
  blocks: [],
  detail: null,
  q: '',
  domain: '',
  warnings: [],
  expTab: 'main',
  experiences: [],
  proposals: [],
  settings: null,
  sphereLevel: 'domains',
  sphereDomain: '',
  sphereNodes: [],
  sphereHandle: null,
  collapsed: new Set(),
  indexPath: [],
  indexMode: 'treemap',
  graphPath: [],
}

export const KNOWLEDGE_KINDS = [
  ['concept', '概念'], ['howto', '操作指南'], ['troubleshoot', '排错'],
  ['reference', '参考'], ['tutorial', '教程'], ['decision', '决策'],
  ['code', '代码'], ['faq', '问答'],
]

export const $ = (sel, root = document) => root.querySelector(sel)

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const fmt = (iso) => {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function typeTag(row) {
  return row.type === 'experience'
    ? `<span class="tag exp">经验${row.kind ? '/' + esc(row.kind) : ''}</span>`
    : '<span class="tag">知识</span>'
}

export function crumbs(domain) {
  const parts = String(domain ?? '').split('/').filter(Boolean)
  if (!parts.length) return '<span class="crumb-item">未分区</span>'
  return parts.map((part, index) => `
    ${index ? '<span class="crumb-sep">›</span>' : ''}
    <span class="crumb-item">${esc(part)}</span>`).join('')
}



