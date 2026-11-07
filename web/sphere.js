/**
 * 三维索引球（零依赖，CSS/JS 投影，不用 WebGL）。
 *
 * 目的：让"索引"变成一个可以转、可以点的空间，而不是一张报表。
 * 做法：斐波那契球面分布 + 每帧把 3D 坐标投影成 2D 屏幕坐标（文字始终面向人，不歪）。
 * 交互：拖动旋转、松手有惯性、静止时缓慢自转；点击节点回调。
 */
const FOV = 620

function fibonacci(n) {
  const points = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i += 1) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    points.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r })
  }
  return points
}

export function createSphere(stage, nodes, { onPick } = {}) {
  const points = fibonacci(nodes.length)
  const elements = nodes.map((node, index) => {
    const el = document.createElement('button')
    el.className = `sphere-node ${node.kind === 'experience' ? 'exp' : ''}`
    el.type = 'button'
    el.textContent = node.label
    el.title = node.label
    el.style.fontSize = `${12 + Math.min(6, Math.sqrt(node.weight ?? 1) * 1.5)}px`
    el.addEventListener('click', (event) => {
      event.stopPropagation()
      if (moved > 6) return
      onPick?.(node)
    })
    stage.appendChild(el)
    return el
  })

  let angleX = -0.25
  let angleY = 0
  let velocityX = 0
  let velocityY = 0.0022
  let dragging = false
  let moved = 0
  let lastX = 0
  let lastY = 0
  let radius = 220
  let raf = 0
  let disposed = false

  const resize = () => {
    const rect = stage.getBoundingClientRect()
    radius = Math.max(90, Math.min(rect.width, rect.height) * 0.36)
  }

  const onPointerDown = (event) => {
    dragging = true
    moved = 0
    lastX = event.clientX
    lastY = event.clientY
    velocityX = 0
    velocityY = 0
  }
  const onPointerMove = (event) => {
    if (!dragging) return
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    moved += Math.abs(dx) + Math.abs(dy)
    angleY += dx * 0.006
    angleX -= dy * 0.006
    velocityY = dx * 0.0006
    velocityX = -dy * 0.0006
  }
  const onPointerUp = () => { dragging = false }

  // 注意：不要在 stage 上 setPointerCapture——捕获之后 click 会落在 stage，
  // 球面上的按钮就永远收不到点击（之前"点了没反应"就是这么来的）。
  stage.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('resize', resize)
  resize()

  const frame = () => {
    if (disposed) return
    if (!dragging) {
      angleY += velocityY
      angleX += velocityX
      velocityY *= 0.97
      velocityX *= 0.97
      // 惯性停下后缓慢自转
      if (Math.abs(velocityY) < 0.0004 && Math.abs(velocityX) < 0.0004) velocityY = 0.0018
      angleX = Math.max(-1.2, Math.min(1.2, angleX))
    }

    const cosY = Math.cos(angleY)
    const sinY = Math.sin(angleY)
    const cosX = Math.cos(angleX)
    const sinX = Math.sin(angleX)

    for (let i = 0; i < points.length; i += 1) {
      const p = points[i]
      // 绕 Y 轴
      const x1 = p.x * cosY + p.z * sinY
      const z1 = -p.x * sinY + p.z * cosY
      // 绕 X 轴
      const y2 = p.y * cosX - z1 * sinX
      const z2 = p.y * sinX + z1 * cosX
      const scale = FOV / (FOV + z2 * radius)
      const screenX = x1 * radius * scale
      const screenY = y2 * radius * scale
      const depth = (z2 + 1) / 2 // 0 远 1 近
      const el = elements[i]
      el.style.transform = `translate(-50%, -50%) translate(${screenX}px, ${screenY}px) scale(${0.78 + scale * 0.22})`
      el.style.opacity = String(0.38 + depth * 0.62)
      el.style.zIndex = String(10 + Math.round(depth * 100))
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return {
    destroy() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      stage.removeEventListener('pointerdown', onPointerDown)
      for (const el of elements) el.remove()
    },
  }
}
