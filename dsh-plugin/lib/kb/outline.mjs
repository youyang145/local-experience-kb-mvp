/**
 * 知识块的目录（outline）。
 *
 * 规则：`#` 视为块标题，不进目录；`##` / `###` 两级进目录；更深的层级不抽
 * （一本书能抽出五十层，反而没法用）。
 * 目录不落库——它是正文的派生视图，明文永远是真源。
 */

const HEADING = /^(#{2,3})\s+(.+?)\s*#*\s*$/

export function parseOutline(body) {
  const text = String(body ?? '')
  const lines = text.split(/\r?\n/)
  const items = []
  let offset = 0
  for (let line = 0; line < lines.length; line += 1) {
    const match = HEADING.exec(lines[line])
    if (match) {
      items.push({
        level: match[1].length,
        title: match[2].trim(),
        anchor: `s${items.length + 1}`,
        line,
        offset,
      })
    }
    offset += lines[line].length + 1
  }
  return items
}

/** 给 CLI 打的一行摘要，比如 "3 节：安装 · 搜索 · 排错"。 */
export function outlineLine(items, { max = 3 } = {}) {
  if (!items.length) return ''
  const titles = items.slice(0, max).map((item) => item.title)
  const more = items.length > max ? ` …共 ${items.length} 节` : ''
  return `${titles.join(' · ')}${more}`
}
