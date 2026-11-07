/**
 * 知识库根目录与目录布局（KB0 的一部分）。
 *
 * 数据与代码分离：默认放在 ~/local-experience-kb，可用 KB_HOME 覆盖。
 * 手稿 ⑩ 原话是"内置于插件文件夹下"，但插件会被 pnpm 重装，数据放里面会丢，
 * 所以 R0 起就分离（冲突登记 C-005）。
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

export const DEFAULT_HOME = path.join(os.homedir(), 'local-experience-kb')

export function kbHome() {
  return process.env.KB_HOME || DEFAULT_HOME
}

/** 目录布局：所有路径只在这里定义一次，其他模块不许自己拼。 */
export function layout(home = kbHome()) {
  return {
    home,
    config: path.join(home, 'kb.json'),
    db: path.join(home, 'index.db'),
    blocks: path.join(home, 'blocks'),
    trash: path.join(home, '_trash'),
    conflicts: path.join(home, '_conflicts'),
  }
}

export function ensureLayout(home = kbHome()) {
  const l = layout(home)
  for (const dir of [l.home, l.blocks, l.trash, l.conflicts]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return l
}

export function readConfig(home = kbHome()) {
  const p = path.join(home, 'kb.json')
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

export function writeConfig(config, home = kbHome()) {
  const p = path.join(home, 'kb.json')
  fs.writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/** 初始化：建目录 + 写 kb.json（已有则不动）。 */
export function initHome(home = kbHome()) {
  const l = ensureLayout(home)
  const existing = readConfig(home)
  if (existing) return { created: false, layout: l, config: existing }
  const config = {
    schema: 1,
    name: '本地知识库',
    createdAt: new Date().toISOString(),
    defaultArea: 'default',
  }
  writeConfig(config, home)
  return { created: true, layout: l, config }
}
