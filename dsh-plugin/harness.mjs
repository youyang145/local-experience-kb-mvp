/**
 * 本地冒烟：不装 DSH，用假 ctx 验证三个工具；库逻辑用插件自带的 lib/kb。
 *
 *   node harness.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './index.mjs'

const DEMO = 'F:\\大项目开发\\dsh插件本地知识库\\测试数据\\_test-kb-m1'

function register(config) {
  const tools = []
  apply({ tools: { register(tool) { tools.push(tool) } } }, config)
  return tools
}

// 演示库：查库 + 目录（code 用默认的 lib/kb）
const demo = register({ home: DEMO })
console.log(`工具数：${demo.length}（${demo.map((t) => t.name).join(', ')}）`)

const consult = demo.find((t) => t.name === 'kb_consult')
const hit = await consult.execute({ query: 'GG 搜不到数值怎么办', limit: 2 }, {})
console.log('\n--- 查库 ---')
console.log(hit.text.split('\n').slice(0, 9).join('\n'))

const skip = await consult.execute({ query: '你好' }, {})
console.log('\n--- 闲聊 ---')
console.log(skip.text)

const index = demo.find((t) => t.name === 'kb_index')
console.log('\n--- 目录 ---')
console.log((await index.execute({}, {})).text.split('\n').slice(0, 3).join('\n'))

// 临时库：验证 kb_stage 只写待分区
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-stage-'))
const staged = register({ home: temp })
const stage = staged.find((t) => t.name === 'kb_stage')
const result = await stage.execute({
  title: '阴影笔记',
  text: '# 阴影原理\n\n从光源看深度。\n\n## 偏差\n\n需要 bias。\n\n## 级联\n\n近处高分辨率。',
}, {})
console.log('\n--- 放进待分区 ---')
console.log(result.text)

const files = fs.readdirSync(path.join(temp, 'blocks', '待分区', 'knowledge'), { recursive: true })
  .filter((f) => String(f).endsWith('.md'))
console.log(`临时库里待分区文件：${files.length} 个`)
fs.rmSync(temp, { recursive: true, force: true })
