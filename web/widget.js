/**
 * 本地知识库挂件（宿主半端注入到 DSH Web 页面）。
 *
 * 行为：右下角一枚可拖动的小按钮；点开是一个小弹窗，里面加载 7788 面板。
 * 不抢焦点、不遮输入框；位置记在 localStorage；面板没启动时给提示。
 */
(function () {
  if (window.__dshKbWidgetLoaded) return
  window.__dshKbWidgetLoaded = true

  const BASE = 'http://127.0.0.1:7788'
  const POS_KEY = 'dsh-kb-widget-pos-v1'
  const SIZE = 44

  const style = document.createElement('style')
  style.textContent = `
    .dsh-kb-btn {
      position: fixed; z-index: 2147483000; width: ${SIZE}px; height: ${SIZE}px;
      border-radius: 50%; display: grid; place-items: center;
      background: linear-gradient(160deg, #2b3448, #171c28);
      border: 1px solid #3a4560; color: #cfe0ff;
      box-shadow: 0 8px 24px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.08);
      cursor: grab; user-select: none; font: 600 17px/1 system-ui, sans-serif;
      transition: transform .12s, box-shadow .12s;
    }
    .dsh-kb-btn:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(0,0,0,.55), 0 0 0 3px rgba(110,168,254,.18); }
    .dsh-kb-btn.dragging { cursor: grabbing; transition: none; }
    .dsh-kb-btn .dot { position:absolute; right:5px; top:5px; width:7px; height:7px; border-radius:50%; background:#7ee0c2; box-shadow:0 0 8px rgba(126,224,194,.8); }
    .dsh-kb-panel {
      position: fixed; z-index: 2147483000; width: 460px; height: 560px;
      max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
      background: #0f1219; border: 1px solid #2a3145; border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0,0,0,.6); overflow: hidden;
      display: none; flex-direction: column;
    }
    .dsh-kb-panel.open { display: flex; }
    .dsh-kb-head {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-bottom: 1px solid #2a3145; color: #cfe0ff; font: 600 12px/1 system-ui, sans-serif;
      letter-spacing: .04em; background: #141822;
    }
    .dsh-kb-head .grow { flex: 1; }
    .dsh-kb-head button {
      background: none; border: 0; color: #8b93a7; cursor: pointer;
      font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 6px;
    }
    .dsh-kb-head button:hover { color: #e7eaf2; background: rgba(255,255,255,.06); }
    .dsh-kb-body { flex: 1; min-height: 0; display: flex; }
    .dsh-kb-frame { flex: 1; width: 100%; height: 100%; border: 0; background: #0b0d12; }
    .dsh-kb-empty { flex: 1; display: grid; place-items: center; color: #8b93a7; font: 12px/1.7 system-ui, sans-serif; text-align: center; padding: 20px; }
    .dsh-kb-empty code { color: #cfe0ff; background: #1a2030; padding: 2px 6px; border-radius: 5px; }
  `
  document.head.appendChild(style)

  const btn = document.createElement('div')
  btn.className = 'dsh-kb-btn'
  btn.title = '本地知识库'
  btn.innerHTML = 'K<span class="dot"></span>'
  document.body.appendChild(btn)

  const panel = document.createElement('div')
  panel.className = 'dsh-kb-panel'
  panel.innerHTML = `
    <div class="dsh-kb-head">
      <span>本地知识库</span><span class="grow"></span>
      <button data-act="open" title="在新标签打开">↗</button>
      <button data-act="close" title="收起">✕</button>
    </div>
    <div class="dsh-kb-body"></div>`
  document.body.appendChild(panel)
  const body = panel.querySelector('.dsh-kb-body')

  function loadPos() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved
    } catch { /* ignore */ }
    return { x: window.innerWidth - SIZE - 20, y: window.innerHeight - SIZE - 150 }
  }

  function clamp(x, y) {
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - SIZE - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - SIZE - 8)),
    }
  }

  function place(pos) {
    btn.style.left = pos.x + 'px'
    btn.style.top = pos.y + 'px'
  }

  let pos = clamp(loadPos().x, loadPos().y)
  place(pos)

  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* ignore */ }
  }

  function placePanel() {
    const rect = panel.getBoundingClientRect()
    let x = pos.x - rect.width + SIZE
    let y = pos.y - rect.height - 10
    if (y < 8) y = pos.y + SIZE + 10
    x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    panel.style.left = x + 'px'
    panel.style.top = y + 'px'
  }

  function errorHtml(error) {
    return `<div class="dsh-kb-empty">
      面板没启动。<br>在 PowerShell 里跑：<br>
      <code>npm run serve</code><br>
      或双击「启动面板.cmd」。<br>
      <span style="opacity:.6">（${String(error && error.message || error)}）</span>
    </div>`
  }

  function open() {
    panel.classList.add('open')
    placePanel()
    // 先把 iframe 放进去，别等健康检查——否则服务慢时会一直卡在“连接中”
    body.innerHTML = `<iframe class="dsh-kb-frame" src="${BASE}/?embed=1" title="本地知识库面板"></iframe>`
    fetch(BASE + '/api/overview', { mode: 'cors', cache: 'no-store' })
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status) })
      .catch((error) => {
        // 只有确认连不上才换成提示
        body.innerHTML = errorHtml(error)
      })
  }

  function close() { panel.classList.remove('open') }

  panel.querySelector('[data-act="close"]').onclick = close
  panel.querySelector('[data-act="open"]').onclick = () => window.open(BASE + '/', '_blank')
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

  let drag = null
  let suppressClick = false
  btn.addEventListener('pointerdown', (e) => {
    drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: 0 }
    suppressClick = false
    btn.classList.add('dragging')
  })
  window.addEventListener('pointermove', (e) => {
    if (!drag) return
    drag.moved = Math.max(drag.moved, Math.abs(e.clientX - pos.x - drag.dx) + Math.abs(e.clientY - pos.y - drag.dy))
    if (drag.moved > 4) suppressClick = true
    pos = clamp(e.clientX - drag.dx, e.clientY - drag.dy)
    place(pos)
    if (panel.classList.contains('open')) placePanel()
  })
  window.addEventListener('pointerup', () => {
    if (!drag) return
    drag = null
    btn.classList.remove('dragging')
    savePos()
  })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    if (suppressClick) { suppressClick = false; return }
    if (panel.classList.contains('open')) close()
    else open()
  })

  window.addEventListener('resize', () => {
    pos = clamp(pos.x, pos.y)
    place(pos)
    if (panel.classList.contains('open')) placePanel()
  })
})()




