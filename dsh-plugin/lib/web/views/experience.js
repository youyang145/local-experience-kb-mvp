/**
 * 经验视图：列表、经验详情。纯渲染，不绑定事件。
 */
import { state, esc, fmt } from '../shared.js'
function expBadges(e) {
  const bits = []
  if (e.tier === 'probation') bits.push('<span class="tag warn">小经验区</span>')
  if (e.status === 'refuted') bits.push('<span class="tag bad">已推翻</span>')
  if (e.orphaned) bits.push('<span class="tag warn">孤儿</span>')
  if (e.kind) bits.push(`<span class="tag">${esc(e.kind)}</span>`)
  bits.push(`<span class="tag ok">${esc(e.domain)}</span>`)
  return bits.join('')
}

export function expDetailHtml(e) {
  const acc = e.accounting ?? {}
  const stat = (label, value) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`
  return `
    <header class="detail-head">
      <button class="btn small back" data-act="back">← 返回</button>
      <div class="crumb"><span class="crumb-item">经验</span><span class="crumb-sep">›</span><span class="crumb-item">${esc(e.domain)}</span></div>
      <h2 class="detail-title">${esc(e.claim ?? e.title)}</h2>
      <div class="meta">${expBadges(e)}<span>优先级 <b>${e.priority ?? '-'}</b></span><span>${esc(e.why ?? '')}</span></div>
    </header>

    <div class="acc-grid">
      ${stat('用过', acc.used ?? 0)}
      ${stat('成了', acc.succeeded ?? 0)}
      ${stat('复现', acc.occurrences ?? 0)}
      ${stat('补充', acc.refined ?? 0)}
      ${stat('人票', acc.human_vote ?? 0)}
    </div>

    <p class="hint">记账由 AI 在对话里自动完成（用到了会自己记）；这里只在你亲手用的时候点一下。</p>
    <div class="actions">
      <button class="btn primary" data-act="apply-success">用过，成了</button>
      <button class="btn" data-act="apply-failure">用过，失败</button>
      <button class="btn" data-act="hit">又遇到（复现）</button>
      <button class="btn" data-act="refine">补充</button>
    </div>

    <details class="more">
      <summary>更多操作（改判断、投票、融合、推翻）</summary>
      <div class="field"><label>判断（一句话）</label><input id="f-claim" type="text" value="${esc(e.claim ?? e.title)}" /></div>
      <div class="field"><label>适用范围</label><input id="f-scope" type="text" value="${esc(e.scope ?? '')}" /></div>
      <div class="field"><label>边界（何时不成立）</label><input id="f-limits" type="text" value="${esc(e.limits ?? '')}" /></div>
      <div class="field"><label>正文</label><textarea id="f-body" style="min-height:140px">${esc(e.body ?? '')}</textarea></div>
      <div class="actions"><button class="btn primary" data-act="save">保存修改</button></div>
      <div class="meta">
        ${e.lineage?.fused_from?.length ? `<span>融合自 ${e.lineage.fused_from.map((x) => `<code>${esc(x)}</code>`).join(' ')}</span>` : ''}
        ${e.lineage?.derived_from?.length ? `<span>派生自 ${e.lineage.derived_from.map((x) => `<code>${esc(x)}</code>`).join(' ')}</span>` : ''}
        ${e.lineage?.superseded_by ? `<span>被替代 <code>${esc(e.lineage.superseded_by)}</code></span>` : ''}
        ${e.lineage?.refuted_by?.length ? `<span>反证 ${esc(e.lineage.refuted_by.join(', '))}</span>` : ''}
      </div>
      <div class="actions">
        <button class="btn small" data-act="vote-up">有用 +1</button>
        <button class="btn small" data-act="vote-down">没用 -1</button>
        <button class="btn small" data-act="pin">${acc.pinned ? '取消置顶' : '置顶'}</button>
        ${e.tier === 'probation' ? '<button class="btn small primary" data-act="promote">转正</button>' : ''}
        <button class="btn small" data-act="merge">融合</button>
        <button class="btn small" data-act="transplant">跨域派生</button>
        <button class="btn small danger" data-act="refute">推翻</button>
        <button class="btn small danger" data-act="delete">删除</button>
      </div>
    </details>`
}

export function viewExp() {
  const all = state.experiences
  const tabs = {
    main: all.filter((e) => e.tier === 'main' && e.status !== 'refuted'),
    probation: all.filter((e) => e.tier === 'probation' && e.status !== 'refuted'),
    refuted: all.filter((e) => e.status === 'refuted'),
  }
  const list = tabs[state.expTab] ?? []
  const cards = list.map((e) => `
    <div class="card" data-open="${esc(e.id)}">
      <div class="head">${expBadges(e)}<span class="claim">${esc(e.claim)}</span></div>
      <div class="why">优先级 ${e.priority} ｜ ${esc(e.why)}</div>
    </div>`).join('') || `<div class="empty"><div><h3>这一栏是空的</h3><p class="dim">${state.expTab === 'probation' ? '免审模式下的经验会先落在这里。' : state.expTab === 'refuted' ? '被推翻的经验留在这里当反例。' : '先在对话里提名，或点「+ 手动记」。'}</p></div></div>`

  return `
    <div class="split ${state.detail ? 'has-detail' : ''}">
      <section class="listpane">
        <div class="tabs">
          <button data-tab="main" class="${state.expTab === 'main' ? 'active' : ''}">主库 ${tabs.main.length}</button>
          <button data-tab="probation" class="${state.expTab === 'probation' ? 'active' : ''}">小经验区 ${tabs.probation.length}</button>
          <button data-tab="refuted" class="${state.expTab === 'refuted' ? 'active' : ''}">反例 ${tabs.refuted.length}</button>
        </div>
        <button class="btn primary" style="width:100%;margin-bottom:10px" data-act="new-exp">+ 手动记一条</button>
        ${cards}
      </section>
      <section class="detail">${state.detail?.type === 'experience' ? expDetailHtml(state.detail) : '<div class="empty"><div><h3>选一条经验</h3><p class="dim">左边点开；或手动记一条。</p></div></div>'}</section>
    </div>`
}


