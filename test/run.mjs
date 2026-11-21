/**
 * 测试入口：顺序导入所有 *.test.mjs，在同一个进程里跑。
 *
 * 为什么不用 `node --test test/`：
 * - Node 22 的 test runner 把目录当文件加载，外部环境会 MODULE_NOT_FOUND；
 * - 某些沙箱/CI 不允许 test runner 为每个文件 spawn 子进程（EPERM）。
 * 顺序导入不 spawn，跨平台稳定；node:test 会照常汇总 pass/fail 并设置退出码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

for (const name of files) {
  await import(pathToFileURL(path.join(dir, name)).href)
}
