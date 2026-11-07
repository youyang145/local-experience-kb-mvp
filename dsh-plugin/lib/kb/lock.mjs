/**
 * 进程间文件锁。
 *
 * 为什么需要：经验的计数是"读文件 → 改 → 写文件"，UI 服务和命令行同时点一下，
 * 后写的会把先写的覆盖掉。SQLite 只能保证数据库那条记录的串行，管不到 markdown 正文。
 *
 * 做法：在 <kb-home>/_locks/ 下用 O_EXCL 建锁文件；拿不到就等 20ms 再试。
 * 只用于写路径，读不加锁（读到的可能是上一版，但不会读到半截——写入是原子的）。
 */
import fs from 'node:fs'
import path from 'node:path'

const sleepArray = new Int32Array(new SharedArrayBuffer(4))
function sleep(ms) {
  Atomics.wait(sleepArray, 0, 0, ms)
}

export function withLock(home, key, fn, { timeoutMs = 3000 } = {}) {
  const dir = path.join(home, '_locks')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${String(key).replace(/[^\w.-]/g, '_')}.lock`)
  const start = Date.now()
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() - start > timeoutMs) throw new Error(`写锁超时：${key}`)
      sleep(20)
    }
  }
  try {
    return fn()
  } finally {
    try { fs.closeSync(fd) } catch { /* ignore */ }
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
}
