/**
 * 面板的 HTTP 层：统一 JSON 请求与错误抛出。
 * 视图不直接 fetch，只调这里。
 */
export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!payload.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
  return payload.data
}
