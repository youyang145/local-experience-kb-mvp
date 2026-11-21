#!/usr/bin/env node
/**
 * 文件级多起点竞速基准（原型，用来回答"值不值得"）。
 *
 * 用法：
 *   node scripts/bench-filescan.mjs --count 10000 --matches 50 --distribution append
 *   --distribution append|middle|uniform   命中文件放在尾部/中部/均匀分布
 *   --concurrency 4                        并行读文件数（默认 4）
 *   --keep                                 保留临时目录
 *
 * 指标：
 *   - 全量扫耗时 / 首条命中耗时 / 凑够 N 条耗时
 *   - 提前停止时的 recall（找到了多少比例的真命中）
 *   - 读了多少文件、多少字节
 *
 * 注意：这是文件层原型，不走索引；结果受磁盘/页面缓存影响，同一台机器多跑几次看趋势。
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const count = Math.max(100, Number(arg('count', 10000)))
const matches = Math.max(1, Number(arg('matches', 50)))
const distribution = String(arg('distribution', 'append'))
const mode = String(arg('mode', 'cooperative'))
const concurrency = Math.max(1, Number(arg('concurrency', 4)))
const keep = process.argv.includes('--keep')
const token = 'NEEDLE_MARKER_9f3a'
const slowArg = String(arg('slow', ''))
const [slowStart, slowEnd, slowDelay] = slowArg ? slowArg.split(':').map(Number) : [0, 0, 0]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-filescan-'))
console.log(`造文件：${count} 个（命中 ${matches}，分布 ${distribution}）→ ${dir}`)

function matchPositions(total, hits, mode) {
  const positions = new Set()
  if (mode === 'append') {
    for (let i = 0; i < hits; i += 1) positions.add(total - hits + i)
  } else if (mode === 'middle') {
    const start = Math.floor((total - hits) / 2)
    for (let i = 0; i < hits; i += 1) positions.add(start + i)
  } else {
    const step = Math.max(1, Math.floor(total / hits))
    for (let i = 0; i < hits; i += 1) positions.add(Math.min(total - 1, i * step))
  }
  return positions
}

const positions = matchPositions(count, matches, distribution)
const writeStart = Date.now()
for (let i = 0; i < count; i += 1) {
  const body = `第 ${i} 个文件。${'填充内容。'.repeat(20)}${positions.has(i) ? `\n${token}\n` : ''}`
  await fs.writeFile(path.join(dir, `note-${String(i).padStart(6, '0')}.md`), body, 'utf8')
}
console.log(`造文件耗时：${((Date.now() - writeStart) / 1000).toFixed(1)}s`)

const names = (await fs.readdir(dir)).sort()

function orderForward(n) { return Array.from({ length: n }, (_, i) => i) }
function orderReverse(n) { return Array.from({ length: n }, (_, i) => n - 1 - i) }
function orderMiddle(n) {
  const out = []
  let left = Math.floor(n / 2)
  let right = left + 1
  out.push(left)
  while (out.length < n) {
    if (right < n) out.push(right++)
    if (left - 1 >= 0) out.push(--left)
  }
  return out
}
function orderRandom(n) {
  const out = Array.from({ length: n }, (_, i) => i)
  let seed = 42
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

async function readFileAt(index) {
  const file = path.join(dir, names[index])
  if (slowDelay > 0 && index >= slowStart && index < slowEnd) await sleep(slowDelay)
  const text = await fs.readFile(file, 'utf8')
  return { index, file, text, bytes: Buffer.byteLength(text), hash: crypto.createHash('sha1').update(text).digest('hex') }
}

async function fullScan() {
  const start = performance.now()
  let found = 0
  let bytes = 0
  let firstAt = null
  let covered = 0
  let t90 = null
  let allAt = null
  const totalMatches = positions.size
  for (let i = 0; i < names.length; i += 1) {
    const r = await readFileAt(i)
    bytes += r.bytes
    covered += 1
    if (t90 === null && covered >= names.length * 0.9) t90 = performance.now() - start
    if (r.text.includes(token)) {
      found += 1
      if (firstAt === null) firstAt = performance.now() - start
      if (allAt === null && found >= totalMatches) allAt = performance.now() - start
    }
  }
  return { ms: performance.now() - start, found, bytes, firstAt, t90, allAt }
}

/** 并发全扫（对照组）：同样开 N 个 worker，但读完全部文件，不提前停。 */
async function concurrentScan() {
  const start = performance.now()
  let ptr = 0
  let found = 0
  let bytes = 0
  let firstAt = null
  let covered = 0
  let t90 = null
  let allAt = null
  const totalMatches = positions.size
  async function worker() {
    while (ptr < names.length) {
      const index = ptr++
      const r = await readFileAt(index)
      bytes += r.bytes
      covered += 1
      if (t90 === null && covered >= names.length * 0.9) t90 = performance.now() - start
      if (r.text.includes(token)) {
        found += 1
        if (firstAt === null) firstAt = performance.now() - start
        if (allAt === null && found >= totalMatches) allAt = performance.now() - start
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { ms: performance.now() - start, found, bytes, firstAt, t90, allAt }
}

/**
 * 竞速：每个通道有自己的顺序，**轮询**取下一个文件（不能饿死后面的通道）；
 * 共享结果池，按内容 hash 去重；达到目标条数即停。
 */
async function race({ target = matches, budgetMs = 60000 } = {}) {
  const channels = [
    { name: '正向', order: orderForward(names.length), ptr: 0, reads: 0, hits: 0, firstAt: null },
    { name: '倒序', order: orderReverse(names.length), ptr: 0, reads: 0, hits: 0, firstAt: null },
    { name: '中间', order: orderMiddle(names.length), ptr: 0, reads: 0, hits: 0, firstAt: null },
    { name: '随机', order: orderRandom(names.length), ptr: 0, reads: 0, hits: 0, firstAt: null },
  ]
  const seen = new Set()
  const found = []
  let firstAt = null
  let firstChannel = null
  let bytes = 0
  let reads = 0
  let turn = 0
  const start = performance.now()

  function next() {
    for (let tries = 0; tries < channels.length; tries += 1) {
      const channel = channels[turn % channels.length]
      turn += 1
      if (channel.ptr < channel.order.length) {
        return { channel, index: channel.order[channel.ptr++] }
      }
    }
    return null
  }

  async function worker() {
    while (found.length < target && performance.now() - start < budgetMs) {
      const item = next()
      if (!item) return
      const r = await readFileAt(item.index)
      item.channel.reads += 1
      reads += 1
      bytes += r.bytes
      if (r.text.includes(token) && !seen.has(r.hash)) {
        seen.add(r.hash)
        found.push(r)
        item.channel.hits += 1
        item.channel.firstAt ??= performance.now() - start
        if (firstAt === null) {
          firstAt = performance.now() - start
          firstChannel = item.channel.name
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return {
    ms: performance.now() - start,
    found: found.length,
    firstAt,
    firstChannel,
    bytes,
    reads,
    channels,
    targetReached: found.length >= target,
  }
}

/**
 * 互助补全：四个方向共享"已完成"集合，各扫一段，合起来覆盖全部。
 * 目标不是抢第一，而是覆盖完；重叠的 index 直接跳过。
 */
async function cooperativeScan() {
  const cursors = [
    { name: '正向', order: orderForward(names.length), ptr: 0, reads: 0, hits: 0 },
    { name: '倒序', order: orderReverse(names.length), ptr: 0, reads: 0, hits: 0 },
    { name: '中间', order: orderMiddle(names.length), ptr: 0, reads: 0, hits: 0 },
    { name: '随机', order: orderRandom(names.length), ptr: 0, reads: 0, hits: 0 },
  ]
  const done = new Set()
  let turn = 0
  let reads = 0
  let skipped = 0
  let bytes = 0
  let found = 0
  let t90 = null
  let allAt = null
  const totalMatches = positions.size
  const start = performance.now()

  function next() {
    for (let tries = 0; tries < cursors.length; tries += 1) {
      const cursor = cursors[turn % cursors.length]
      turn += 1
      while (cursor.ptr < cursor.order.length && done.has(cursor.order[cursor.ptr])) cursor.ptr += 1
      if (cursor.ptr < cursor.order.length) return { cursor, index: cursor.order[cursor.ptr++] }
    }
    return null
  }

  async function worker() {
    while (done.size < names.length) {
      const item = next()
      if (!item) return
      if (done.has(item.index)) { skipped += 1; continue }
      const r = await readFileAt(item.index)
      done.add(item.index)
      reads += 1
      bytes += r.bytes
      if (t90 === null && done.size >= names.length * 0.9) t90 = performance.now() - start
      item.cursor.reads += 1
      if (r.text.includes(token)) {
        found += 1
        item.cursor.hits += 1
        if (allAt === null && found >= totalMatches) allAt = performance.now() - start
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { ms: performance.now() - start, reads, skipped, bytes, found, covered: done.size, cursors, total: names.length, t90, allAt }
}

const target = Math.max(1, Math.min(Number(arg('target', 10)), matches))
const full = await fullScan()
const concurrent = await concurrentScan()

if (mode === 'cooperative') {
  const coop = await cooperativeScan()
  console.log('')
  console.log('| 指标 | 顺序全扫 | 并发全扫 | 互助补全（四方向） |')
  console.log('|---|---|---|---|')
  console.log(`| 耗时 | ${full.ms.toFixed(1)} ms | ${concurrent.ms.toFixed(1)} ms | ${coop.ms.toFixed(1)} ms |`)
  console.log(`| 覆盖 | ${names.length} | ${names.length} | ${coop.covered}/${coop.total} |`)
  console.log(`| 90% 覆盖 | ${full.t90?.toFixed(1)} ms | ${concurrent.t90?.toFixed(1)} ms | ${coop.t90?.toFixed(1)} ms |`)
  console.log(`| 全部命中找到 | ${full.allAt?.toFixed(1)} ms | ${concurrent.allAt?.toFixed(1)} ms | ${coop.allAt?.toFixed(1)} ms |`)
  console.log(`| 命中 | ${full.found} | ${concurrent.found} | ${coop.found} |`)
  console.log(`| recall | 100% | 100% | ${(coop.found / full.found * 100).toFixed(1)}% |`)
  console.log(`| 读文件 | ${names.length} | ${names.length} | ${coop.reads} |`)
  console.log(`| 重复跳过 | — | — | ${coop.skipped} |`)
  console.log(`| 读字节 | ${(full.bytes / 1024).toFixed(0)} KB | ${(concurrent.bytes / 1024).toFixed(0)} KB | ${(coop.bytes / 1024).toFixed(0)} KB |`)
  console.log('')
  console.log('各方向：')
  console.log('| 方向 | 读文件 | 命中 |')
  console.log('|---|---|---|')
  for (const cursor of coop.cursors) console.log(`| ${cursor.name} | ${cursor.reads} | ${cursor.hits} |`)
  if (!keep) await fs.rm(dir, { recursive: true, force: true })
  else console.log(`\n临时目录保留在：${dir}`)
  process.exit(0)
}

const raceResult = await race({ target })
const recall = full.found ? raceResult.found / full.found : 1

console.log('')
console.log('| 指标 | 顺序全扫 | 并发全扫 | 四通道竞速（目标 ' + target + ' 条） |')
console.log('|---|---|---|---|')
console.log(`| 耗时 | ${full.ms.toFixed(1)} ms | ${concurrent.ms.toFixed(1)} ms | ${raceResult.ms.toFixed(1)} ms |`)
console.log(`| 首条命中 | ${full.firstAt === null ? '无' : full.firstAt.toFixed(1) + ' ms'} | ${concurrent.firstAt === null ? '无' : concurrent.firstAt.toFixed(1) + ' ms'} | ${raceResult.firstAt === null ? '无' : raceResult.firstAt.toFixed(1) + ' ms（${raceResult.firstChannel}）'} |`)
console.log(`| 找到命中 | ${full.found} | ${concurrent.found} | ${raceResult.found} |`)
console.log(`| recall（提前停止时） | 100% | 100% | ${(recall * 100).toFixed(1)}% |`)
console.log(`| 读文件数 | ${names.length} | ${names.length} | ${raceResult.reads} |`)
console.log(`| 读字节 | ${(full.bytes / 1024).toFixed(0)} KB | ${(concurrent.bytes / 1024).toFixed(0)} KB | ${(raceResult.bytes / 1024).toFixed(0)} KB |`)
console.log(`| 目标条数 / 是否达到 | — | — | ${target} / ${raceResult.targetReached ? '是' : '否'} |`)
console.log(`| 并行度 | 1 | ${concurrency} | ${concurrency} |`)
console.log('')
console.log('各通道：')
console.log('| 通道 | 读文件 | 命中 | 首条命中 |')
console.log('|---|---|---|---|')
for (const channel of raceResult.channels) {
  console.log(`| ${channel.name} | ${channel.reads} | ${channel.hits} | ${channel.firstAt === null ? '无' : channel.firstAt.toFixed(1) + ' ms'} |`)
}

if (!keep) await fs.rm(dir, { recursive: true, force: true })
else console.log(`\n临时目录保留在：${dir}`)



