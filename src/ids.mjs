/**
 * 唯一身份标识（KB1）。
 *
 * 依据手稿 ⑦："所有内容创建时拥有各自的唯一身份标识，或用创建日期 Hash 作为自身标识
 * （不止日期，由多因素）。"
 * 所以 id = 前缀 k + 创建日期(YYMMDD) + 多因素哈希的 base36 尾段。
 * 不把内容纳入身份：内容改了还是同一个块，只涨 version（否则 used/succeeded 会断）。
 */
import { createHash, randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function base36(buffer, length) {
  let n = 0n
  for (const byte of buffer) n = (n << 8n) | BigInt(byte)
  let out = ''
  while (n > 0n && out.length < length) {
    out = ALPHABET[Number(n % 36n)] + out
    n /= 36n
  }
  return out.padStart(length, '0')
}

/**
 * 生成 id。因素：创建时刻 + 标题 + 随机盐（可注入，测试用）。
 * 形如 k2610317f3a2c：按日期可排序，13 字符便于手打。
 */
export function newId({ at = new Date(), title = '', salt } = {}) {
  const stamp = [
    String(at.getFullYear()).slice(-2),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
  ].join('')
  const seed = `${at.toISOString()}|${title}|${salt ?? randomBytes(8).toString('hex')}`
  const digest = createHash('sha256').update(seed, 'utf8').digest()
  return `k${stamp}${base36(digest.subarray(0, 4), 6)}`
}

/** 内容指纹：只用于去重与检测改动，不参与身份。 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/** 分片目录名：取 id 的随机尾段前两位，避免同一天的块堆在一个目录里。 */
export function shardOf(id) {
  return id.slice(-6, -4) || '00'
}
