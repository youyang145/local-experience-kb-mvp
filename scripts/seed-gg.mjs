/**
 * 灌入 GameGuardian 的骨架知识（P1 样板）。
 *
 * 原则：只写能核实的（官方站点/论坛链接存在的事实），具体步骤一律标【待实测】。
 * 目的是验证"知识块按类型拆开 + 目录"在真实主题上顺不顺，不是冒充完整手册。
 *
 *   node scripts/seed-gg.mjs --home F:\大项目开发\_test-kb-m1
 */
import { initHome, layout } from '../src/config.mjs'
import { openDb, upsertBlock } from '../src/db.mjs'
import { buildCandidate } from '../src/capture.mjs'
import { writeBlockFile } from '../src/blocks.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const home = arg('home', layout().home)

const blocks = [
  {
    title: 'GameGuardian 是什么',
    kind: 'concept',
    tags: ['GameGuardian', 'Android', '内存'],
    source: 'https://gameguardian.net/help',
    summary: 'Android 上的内存搜索与修改工具；官方 help 与论坛是唯一可信资料源。',
    body: `## 定义
GameGuardian（常简称 GG）是 Android 平台的内存搜索与修改工具，官方站点 gameguardian.net。

## 已核实的事实
- 官方提供使用说明与 Lua 脚本参考：https://gameguardian.net/help
- 官方论坛有 XOR 搜索指南（标注 GG 8.29.0+）：https://gameguardian.net/forum/topic/17502-xor-search-guide-gg-8290/
- 社区脚本使用 Lua，常见接口包括 getValues / setValues（官方论坛有讨论）

## 待实测
- 安装方式：root 还是虚拟空间，对应版本要求
- 目标 Android 版本、机型与权限差异

## 边界
只用于你有权修改的单机/离线环境；联机使用可能违反游戏服务条款，后果自负。`,
  },
  {
    title: 'GameGuardian 官方资料入口',
    kind: 'reference',
    tags: ['GameGuardian', '官方', '链接'],
    source: 'https://gameguardian.net',
    summary: 'help、论坛、下载、XOR 指南、Lua 讨论的官方入口清单。',
    body: `## 官方
- 使用说明与 Lua 参考：https://gameguardian.net/help
- 官方下载：https://gameguardian.net/forum/files/category/5-official-downloads/
- 论坛：https://gameguardian.net/forum/

## 专题
- XOR 搜索指南（GG 8.29.0+）：https://gameguardian.net/forum/topic/17502-xor-search-guide-gg-8290/
- 内存转储讨论：https://gameguardian.net/forum/topic/29705-dump-memory-with-gg
- Lua 读写接口讨论：https://gameguardian.net/forum/topic/47720-gg-prompt-getvalues-and-setvalues/

## 使用约定
外部教程只作线索；参数、菜单名、版本差异一律以官方 help 与自己实测为准。`,
  },
  {
    title: 'GG 基础搜索流程（骨架，待实测）',
    kind: 'howto',
    tags: ['GameGuardian', '搜索'],
    source: 'https://gameguardian.net/help',
    summary: '选择进程 → 搜索 → 改善 → 修改 的骨架；菜单名与细节待实测。',
    body: `## 前置
- 已安装并授权（root 或虚拟空间，【待实测】具体方式）
- 已选定目标进程（【待实测】选择入口与限制）

## 步骤
1. 搜索：按数值类型（如 DWORD / FLOAT）做首次搜索
2. 改善：结果过多时，改变游戏内数值再搜"变大/变小/未变"
3. 收敛：候选降到个位数
4. 修改：写入目标值并观察游戏内变化

> 【待实测】各步骤的菜单名、按钮位置、类型选项以你机器上的 GG 版本为准。

## 结果
候选收敛后可稳定修改；首次修改前建议备份存档。

## 边界
数值被加密（如 XOR）、多级指针、服务器校验等情况，这套流程可能无效。`,
  },
  {
    title: 'GG 搜不到数值（待实测）',
    kind: 'troubleshoot',
    tags: ['GameGuardian', '排错', '搜索'],
    source: 'https://gameguardian.net/forum/topic/17502-xor-search-guide-gg-8290/',
    summary: '搜不到时的排查方向：类型错、数值加密、多级指针、范围不对。',
    body: `## 症状
首次搜索或改善后，候选为 0，或结果始终不收敛。

## 可能原因
- 数值类型选错（整数 / 浮点 / 字节）
- 数值被加密或混淆（官方有 XOR 搜索指南）
- 多级指针：显示值不是内存里的原始值
- 搜索范围或内存区域不对

## 修复方向
1. 换数值类型再搜
2. 按官方 XOR 指南尝试 XOR 搜索（GG 8.29.0+）
3. 用范围搜索、联合搜索缩小候选
4. 先转储内存观察结构（官方论坛有 dump 讨论）

## 待实测
以上每条在本机 GG 版本上的具体入口与效果。

## 还不行怎么办
记录：游戏名、版本、数值类型、尝试过的搜索方式、结果数量变化。带着这些去官方论坛搜同类问题。`,
  },
  {
    title: 'GG Lua 脚本：读写数值（骨架）',
    kind: 'code',
    tags: ['GameGuardian', 'Lua', '脚本'],
    source: 'https://gameguardian.net/help/index.html',
    summary: 'Lua 脚本的最小骨架：找到地址、读值、写值；接口以官方 help 为准。',
    body: `## 用途
把"搜索 → 修改"固化成脚本，方便重复使用。

## 代码（骨架，接口名待核对）
\`\`\`lua
-- 【待实测】以下为结构示意，函数签名以官方 Lua 参考为准
local addr = gg.getResults(1)          -- 取一条搜索结果
gg.getValues(addr)                     -- 读当前值
gg.setValues({{address = addr[1].address, value = 999, flags = gg.TYPE_DWORD}})  -- 写值
\`\`\`

## 依赖
- GG 内置 Lua 环境
- 官方 Lua 参考：https://gameguardian.net/help/index.html

## 注意
- 写值前先读值确认地址正确，避免写错内存
- 不同版本接口可能有差异，跑之前先在测试存档上验证`,
  },
  {
    title: '为什么优先联合搜索而不是逐个试（待实测）',
    kind: 'decision',
    tags: ['GameGuardian', '决策', '搜索'],
    source: 'https://gameguardian.net/help',
    summary: '用相邻数值一起搜来缩小候选，减少反复改善的次数。',
    body: `## 背景
单一数值搜出来动辄上万条，逐条改善很慢。

## 选项
- A：只搜一个值，反复改善
- B：把几个相邻/相关的值一起搜（联合搜索），一次缩小候选

## 决定
优先 B；只有在找不到相邻值时才退回 A。

## 后果
- B 更快，但要求你能在界面上同时看到多个相关数值
- B 搜不到时，说明这些值在内存里不相邻或类型不同，需要换思路

## 待实测
联合搜索的具体语法（分隔符）、上限与在本机版本上的表现。`,
  },
]

initHome(home)
const db = openDb(layout(home).db)
let created = 0
for (const [index, input] of blocks.entries()) {
  const block = buildCandidate({
    title: input.title,
    body: input.body,
    summary: input.summary,
    source: input.source,
    domain: '工具',
    kind: input.kind,
    tags: input.tags,
  }, { salt: `gg-${index}` })
  const existing = db.prepare('SELECT id FROM blocks WHERE title = ? AND deleted_at IS NULL').get(input.title)
  if (existing) continue
  const abs = writeBlockFile(home, block)
  upsertBlock(db, { ...block, path: abs })
  created += 1
}
db.close()
console.log(`已写入 ${created} 条 GameGuardian 骨架知识到 ${home}`)
