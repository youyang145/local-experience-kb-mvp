/**
 * 中文检索的分词（KB4 的地基）。
 *
 * 实测过的坑：SQLite FTS5 的 trigram 分词对**两字词**无效（MATCH "知识" 返回 0 条），
 * 而中文查询大量是两字词；unicode61 又会把整句当一个 token。
 * 所以写入时自己切好：汉字按二元组切，拉丁词与数字整词保留；
 * 查询时同样切，二元组用短语查询保住相邻顺序。
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

export function normalize(text) {
  // 只做 NFC + 空白折叠：NFKC 会把全角逗号、括号改成半角，改的是原文，不该在存储层做。
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** 把文本切成「片段」：汉字段、拉丁段。索引和查询共用这一套规则。 */
export function segments(text) {
  const out = []
  const re = /[\u3400-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_]+/g
  // 检索侧才做 NFKC：兼容全角字母、数字与符号。
  for (const match of String(text ?? '').normalize('NFKC').matchAll(re)) {
    const s = match[0]
    if (CJK.test(s)) {
      if (s.length === 1) {
        out.push({ kind: 'cjk', bigrams: [s], text: s })
      } else {
        const bigrams = []
        for (let i = 0; i < s.length - 1; i += 1) bigrams.push(s.slice(i, i + 2))
        out.push({ kind: 'cjk', bigrams, text: s })
      }
    } else {
      out.push({ kind: 'word', text: s.toLowerCase() })
    }
  }
  return out
}

/** 写索引用的 token 串：二元组与整词用空格连起来交给 unicode61。 */
export function indexTokens(text) {
  const tokens = []
  for (const seg of segments(text)) {
    if (seg.kind === 'cjk') tokens.push(...seg.bigrams)
    else tokens.push(seg.text)
  }
  return tokens.join(' ')
}

/**
 * 查询转 FTS5 表达式。
 * 汉字段用短语（"知识 识库"）保证相邻；拉丁词直接 quote。
 * 单字查询无法成二元组，交给调用方走 LIKE 兜底。
 */
export function queryExpression(text) {
  const parts = []
  for (const seg of segments(text)) {
    if (seg.kind === 'cjk') {
      // 单字无法成二元组，交给调用方走 LIKE 兜底；两字词恰好一个二元组，仍走 FTS。
      if (seg.text.length === 1) return null
      parts.push(`"${seg.bigrams.join(' ')}"`)
    } else {
      parts.push(`"${seg.text}"`)
    }
  }
  if (parts.length === 0) return null
  return parts.join(' AND ')
}

/** 摘要层截断：不超过 max 个字符。 */
export function clip(text, max = 200) {
  const s = normalize(text)
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
