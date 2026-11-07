#!/usr/bin/env node
/**
 * kb 命令行入口（薄壳）。
 * 所有逻辑都在 src/ 里，这里只做参数转发，方便单独 import 各模块做测试。
 */
import { run } from '../src/cli.mjs'

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code ?? 0
}, (error) => {
  console.error(`kb: ${error.message}`)
  process.exitCode = 1
})
