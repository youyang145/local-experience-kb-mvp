/**
 * 本地知识库挂件：右下角一枚按钮，点开是一个完整的小窗口（可拖动、可缩放）。
 * 窗口里直接加载 7788 面板；拖动/缩放/位置都记在 localStorage。
 */
(function () {
  if (window.__dshKbWidgetLoaded) return
  window.__dshKbWidgetLoaded = true

  const BASE = 'http://127.0.0.1:7788'
  const POS_KEY = 'dsh-kb-widget-box-v1'
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

    .dsh-kb-window {
      position: fixed; z-index: 2147483000;
      display: none; flex-direction: column;
      background: #0f1219; border: 1px solid #2a3145; border-radius: 14px;
      box-shadow: 0 26px 70px rgba(0,0,0,.65); overflow: hidden;
      min-width: 420px; min-height: 340px;
    }
    .dsh-kb-window.open { display: flex; }
    .dsh-kb-head {
      height: 34px; flex: 0 0 34px; display: flex; align-items: center; gap: 8px;
      padding: 0 8px 0 12px; cursor: grab; user-select: none;
      background: #141822; border-bottom: 1px solid #2a3145;
      color: #cfe0ff; font: 600 12px/1 system-ui, sans-serif; letter-spacing: .04em;
    }
    .dsh-kb-head.dragging { cursor: grabbing; }
    .dsh-kb-title { flex: 0 0 auto; }
    .dsh-kb-chips { flex: 1; display: flex; gap: 6px; color: #8b93a7; font-weight: 400; font-size: 11px; overflow: hidden; white-space: nowrap; }
    .dsh-kb-chips .chip { border: 1px solid #2a3145; border-radius: 999px; padding: 1px 7px; background: rgba(255,255,255,.02); }
    .dsh-kb-chips b { color: #e7eaf2; }
    .dsh-kb-head button {
      background: none; border: 0; color: #8b93a7; cursor: pointer;
      font-size: 14px; line-height: 1; padding: 5px 6px; border-radius: 6px;
    }
    .dsh-kb-head button:hover { color: #e7eaf2; background: rgba(255,255,255,.06); }
    .dsh-kb-pending { border: 1px solid #2a3145 !important; border-radius: 999px !important; padding: 3px 9px !important; font-size: 11px !important; color: #8b93a7 !important; }
    .dsh-kb-pending b { color: #6ea8fe; }
    .dsh-kb-pending.hot { border-color: rgba(110,168,254,.5) !important; color: #cfe0ff !important; }
    .dsh-kb-body { flex: 1; min-height: 0; display: flex; }
    .dsh-kb-frame { flex: 1; width: 100%; height: 100%; border: 0; background: #0b0d12; }
    .dsh-kb-empty { flex: 1; display: grid; place-items: center; color: #8b93a7; font: 12px/1.7 system-ui, sans-serif; text-align: center; padding: 20px; }
    .dsh-kb-empty code { color: #cfe0ff; background: #1a2030; padding: 2px 6px; border-radius: 5px; }
    .dsh-kb-resize {
      position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
      cursor: nwse-resize; z-index: 5;
      background: linear-gradient(135deg, transparent 50%, #3a4560 50%, #3a4560 62%, transparent 62%, transparent 72%, #3a4560 72%, #3a4560 84%, transparent 84%);
      opacity: .8;
    }
    .dsh-kb-resize:hover { opacity: 1; }
  `
  document.head.appendChild(style)

  const btn = document.createElement('div')
  btn.className = 'dsh-kb-btn'
  btn.title = '本地知识库'
  btn.innerHTML = 'K<span class="dot"></span>'
  document.body.appendChild(btn)

  const win = document.createElement('div')
  win.className = 'dsh-kb-window'
  win.innerHTML = `
    <div class="dsh-kb-head" data-drag="1">
      <span class="dsh-kb-title">本地知识库</span>
      <span class="dsh-kb-chips"></span>
      <button data-act="pending" class="dsh-kb-pending" title="待拍板">待拍板 <b>0</b></button>
      <button data-act="close" title="关闭">✕</button>
    </div>
    <div class="dsh-kb-body"></div>
    <div class="dsh-kb-resize" title="拖动缩放"></div>`
  document.body.appendChild(win)
  const head = win.querySelector('.dsh-kb-head')
  const body = win.querySelector('.dsh-kb-body')
  const chips = win.querySelector('.dsh-kb-chips')
  let panelBase = BASE


  const clamp = (v, min, max) => Math.max(min, Math.min(v, max))

  function defaultBox() {
    const width = clamp(Math.round(window.innerWidth * 0.9), 760, 1100)
    const height = clamp(Math.round(window.innerHeight * 0.78), 520, 760)
    return { width, height, x: window.innerWidth - width - 16, y: window.innerHeight - height - 24 }
  }

  function loadBox() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) return saved
    } catch { /* ignore */ }
    return defaultBox()
  }

  function fit(box) {
    const width = clamp(box.width, 420, Math.max(420, window.innerWidth - 8))
    const height = clamp(box.height, 340, Math.max(340, window.innerHeight - 8))
    return {
      width,
      height,
      x: clamp(box.x, 8, Math.max(8, window.innerWidth - width - 8)),
      y: clamp(box.y, 8, Math.max(8, window.innerHeight - height - 8)),
    }
  }

  let box = fit(loadBox())
  function applyBox() {
    win.style.width = box.width + 'px'
    win.style.height = box.height + 'px'
    win.style.left = box.x + 'px'
    win.style.top = box.y + 'px'
  }
  function saveBox() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(box)) } catch { /* ignore */ }
  }
  applyBox()

  function placeButton() {
    btn.style.left = clamp(window.innerWidth - SIZE - 20, 8, window.innerWidth - SIZE - 8) + 'px'
    btn.style.top = clamp(window.innerHeight - SIZE - 150, 8, window.innerHeight - SIZE - 8) + 'px'
  }
  placeButton()

  async function refreshChips() {
    try {
      const res = await fetch(BASE + '/api/overview', { mode: 'cors', cache: 'no-store' })
      if (!res.ok) return
      const payload = await res.json()
      const stats = payload?.data?.stats ?? {}
      chips.innerHTML = `<span class="chip">块 <b>${stats.blocks ?? '-'}</b></span><span class="chip">经验 <b>${stats.experience ?? '-'}</b></span>`
      const pend = await fetch(BASE + '/api/proposals', { mode: 'cors', cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      const pending = Array.isArray(pend?.data) ? pend.data.length : 0
      const btnPending = win.querySelector('[data-act="pending"]')
      if (btnPending) {
        btnPending.querySelector('b').textContent = String(pending)
        btnPending.classList.toggle('hot', pending > 0)
      }
    } catch { /* 面板没起就不显示 */ }
  }

  function openWindow() {
    box = fit(box)
    applyBox()
    win.classList.add('open')
    body.innerHTML = '<div class="dsh-kb-empty">正在打开面板…</div>'
    fetch('/dsh-kb/start', { cache: 'no-store' })
      .then((res) => res.json())
      .then((payload) => {
        if (!payload?.ok) throw new Error(payload?.error ?? '面板没起来')
        panelBase = String(payload.url ?? BASE).replace(/\/$/, '')
        body.innerHTML = `<iframe class="dsh-kb-frame" src="${panelBase}/?embed=1" title="本地知识库"></iframe>`
        refreshChips()
      })
      .catch((error) => {
        body.innerHTML = `<div class="dsh-kb-empty">
          面板没启动。<br>可以在 DSH 里重启插件后再试。<br>
          <span style="opacity:.6">（${String(error && error.message || error)}）</span>
        </div>`
      })
  }

  function closeWindow() { win.classList.remove('open') }

  win.querySelector('[data-act="close"]').onclick = closeWindow
  win.querySelector('[data-act="pending"]').onclick = () => {
    if (!win.classList.contains('open')) openWindow()
    const jump = (tries = 0) => {
      const frame = body.querySelector('iframe')
      if (frame) frame.src = panelBase + '/?embed=1&proposals=1'
      else if (tries < 20) setTimeout(() => jump(tries + 1), 100)
    }
    jump()
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWindow() })

  // 拖动标题栏
  let drag = null
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return
    drag = { dx: e.clientX - box.x, dy: e.clientY - box.y }
    head.classList.add('dragging')
    head.setPointerCapture?.(e.pointerId)
  })
  window.addEventListener('pointermove', (e) => {
    if (!drag) return
    box = fit({ ...box, x: e.clientX - drag.dx, y: e.clientY - drag.dy })
    applyBox()
  })
  window.addEventListener('pointerup', () => {
    if (!drag) return
    drag = null
    head.classList.remove('dragging')
    saveBox()
  })

  // 右下角缩放
  let resize = null
  win.querySelector('.dsh-kb-resize').addEventListener('pointerdown', (e) => {
    e.preventDefault()
    resize = { sx: e.clientX, sy: e.clientY, w: box.width, h: box.height }
    e.target.setPointerCapture?.(e.pointerId)
  })
  window.addEventListener('pointermove', (e) => {
    if (!resize) return
    box = fit({ ...box, width: resize.w + (e.clientX - resize.sx), height: resize.h + (e.clientY - resize.sy) })
    applyBox()
  })
  window.addEventListener('pointerup', () => {
    if (!resize) return
    resize = null
    saveBox()
  })

  // 按钮：拖动 + 点击
  let btnDrag = null
  let suppressClick = false
  btn.addEventListener('pointerdown', (e) => {
    const r = btn.getBoundingClientRect()
    btnDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: 0 }
    suppressClick = false
    btn.classList.add('dragging')
  })
  window.addEventListener('pointermove', (e) => {
    if (!btnDrag) return
    btnDrag.moved = Math.max(btnDrag.moved, Math.abs(e.clientX - btnDrag.dx) + Math.abs(e.clientY - btnDrag.dy))
    if (btnDrag.moved > 4) suppressClick = true
    btn.style.left = clamp(e.clientX - btnDrag.dx, 8, window.innerWidth - SIZE - 8) + 'px'
    btn.style.top = clamp(e.clientY - btnDrag.dy, 8, window.innerHeight - SIZE - 8) + 'px'
  })
  window.addEventListener('pointerup', () => {
    if (!btnDrag) return
    btnDrag = null
    btn.classList.remove('dragging')
  })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    if (suppressClick) { suppressClick = false; return }
    if (win.classList.contains('open')) closeWindow()
    else openWindow()
  })

  window.addEventListener('resize', () => {
    box = fit(box)
    applyBox()
    placeButton()
  })
})()








