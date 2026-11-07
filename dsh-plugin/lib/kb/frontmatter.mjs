/**
 * 块头（front matter）的读写。只支持我们用到的一个小子集：
 *   - key: 标量
 *   - key: [a, b]
 *   - key: 空 → 下面缩进两格是一个嵌套对象（只有 experience 用到）
 *
 * 不用第三方 YAML：依赖能省则省，格式我们自己定死，坏格式直接报错而不是猜。
 */

const ORDER = [
  'id', 'type', 'kind', 'title', 'summary', 'source', 'domain', 'tags', 'primary_knowledge',
  'orphaned', 'tier', 'status', 'claim', 'scope', 'limits',
  'created_at', 'modified_at', 'version', 'editor', 'status_note',
  'content_hash', 'derived_from', 'links', 'lineage', 'accounting', 'evidence',
]

function parseScalar(raw) {
  const s = raw.trim()
  if (s === '') return ''
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((x) => unquote(x.trim())).filter((x) => x !== '')
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null') return null
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10)
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s)
  return unquote(s)
}

/** 引号包裹的值按 JSON 字符串解，避免把手写的转义序列吃掉。 */
function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) } catch { return s.slice(1, -1) }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1)
  return s
}

/** 值里若含特殊字符，输出时加引号，保证能原样读回。 */
function formatScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const s = String(value)
  // 空串必须写成 ""：裸写 `key:` 会被解析成"下面缩进的是嵌套对象"，和空值混淆。
  if (s === '') return '""'
  if (/[:\n\r#]|^\s|\s$/.test(s) || /^[\[{]/.test(s)) return JSON.stringify(s)
  return s
}

export function parseFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { meta: {}, body: src }
  const meta = {}
  let parent = null
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = /^(\s*)/.exec(raw)[1].length
    const line = raw.trim()
    const idx = line.indexOf(':')
    if (idx < 0) throw new Error(`块头解析失败，这一行没有冒号：${line}`)
    const key = line.slice(0, idx).trim()
    const rest = line.slice(idx + 1).trim()
    if (indent > 0 && parent) {
      meta[parent][key] = parseScalar(rest)
      continue
    }
    if (rest === '') {
      parent = key
      meta[key] = {}
      continue
    }
    parent = null
    meta[key] = parseScalar(rest)
  }
  return { meta, body: src.slice(m[0].length) }
}

export function serializeFrontmatter(meta, body = '') {
  const keys = [...ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !ORDER.includes(k))]
  const lines = ['---']
  for (const key of keys) {
    const value = meta[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const [k, v] of Object.entries(value)) {
        lines.push(`${'  '}${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : formatScalar(v)}`)
      }
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`)
    } else {
      const formatted = formatScalar(value)
      lines.push(formatted === '' ? `${key}:` : `${key}: ${formatted}`)
    }
  }
  lines.push('---')
  const text = String(body ?? '').replace(/\s+$/, '')
  return `${lines.join('\n')}\n${text}\n`
}
