/**
 * 整库备份与恢复。
 *
 * 设计取舍（和 悠扬工具箱 2.0 的备份思路一致）：
 * - 整个库打成一个包，不单独备份索引——索引和明文分开最容易对不上；
 * - 包内先放 manifest.json（每个文件的 sha256、大小、路径），恢复时先校验再写；
 * - 恢复两种模式：overwrite（镜像覆盖）和 merge（增量去重：相同的跳过，缺的补，变了的覆盖）；
 * - 覆盖前自动做一次安全备份，放在 _backup/pre-restore-*.zip；
 * - 备份包本身不参与备份（避免递归）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeZip, readZip } from './zip.mjs'

export const BACKUP_DIR = '_backup'
export const MANIFEST = 'manifest.json'
const FORMAT = 'local-experience-kb/backup'
const FORMAT_VERSION = 1
// SQLite 运行时生成的临时文件，不参与备份/恢复比较
const TRANSIENT = new Set(['index.db-wal', 'index.db-shm'])

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === BACKUP_DIR || TRANSIENT.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, base, out)
    else out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') })
  }
  return out
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 列出库里可备份的文件（不含 _backup）。 */
export function scan(home, { includeTrash = true, includeIndex = true } = {}) {
  return walk(home)
    .filter((f) => (includeTrash ? true : !f.rel.startsWith('_trash/')))
    .filter((f) => (includeIndex ? true : f.rel !== 'index.db'))
    .map((f) => {
      const stat = fs.statSync(f.abs)
      return { rel: f.rel, abs: f.abs, size: stat.size, mtime: stat.mtime }
    })
}

/** 备份保留策略：只留最近 keep 个，其余删除。 */
export function pruneBackups(home, keep) {
  const limit = Number(keep)
  if (!Number.isFinite(limit) || limit <= 0) return []
  const items = listBackups(home)
  const removed = []
  for (const item of items.slice(limit)) {
    try { fs.rmSync(item.path, { force: true }); removed.push(item.name) } catch { /* 占用就跳过 */ }
  }
  return removed
}

/**
 * 创建一个整库备份。
 * @returns {{path:string, files:number, bytes:number, createdAt:string, pruned:string[]}}
 */
export function createBackup(home, { out, includeTrash = true, includeIndex = true, keep = 0 } = {}) {
  const files = scan(home, { includeTrash, includeIndex })
  const entries = []
  const manifestFiles = []
  for (const file of files) {
    const data = fs.readFileSync(file.abs)
    entries.push({ name: file.rel, data, mtime: file.mtime })
    manifestFiles.push({ path: file.rel, size: data.length, sha256: sha256(data), mtime: file.mtime.toISOString() })
  }

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    home,
    includeTrash,
    includeIndex,
    fileCount: manifestFiles.length,
    files: manifestFiles,
  }
  entries.unshift({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: new Date() })

  const zip = writeZip(entries)

  const dir = path.join(home, BACKUP_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const target = out ? path.resolve(out) : path.join(dir, `kb-backup-${stamp()}.zip`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, zip)
  fs.renameSync(tmp, target)
  const pruned = keep ? pruneBackups(home, keep) : []
  return { path: target, files: manifestFiles.length, bytes: zip.length, createdAt: manifest.createdAt, includeTrash, includeIndex, pruned }
}

/** 列出本地备份包。 */
export function listBackups(home) {
  const dir = path.join(home, BACKUP_DIR)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => {
      const abs = path.join(dir, name)
      const stat = fs.statSync(abs)
      return { name, path: abs, bytes: stat.size, mtime: stat.mtime.toISOString() }
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
}

/** 读包并校验：manifest 必须存在，列出的文件必须都在且哈希一致。 */
export function inspectBackup(zipPath) {
  const raw = fs.readFileSync(zipPath)
  const entries = readZip(raw)
  const manifestBuf = entries.get(MANIFEST)
  if (!manifestBuf) throw new Error('包里没有 manifest.json，不是本工具的备份')
  const manifest = JSON.parse(manifestBuf.toString('utf8'))
  if (manifest.format !== FORMAT) throw new Error('备份格式不匹配')
  const problems = []
  for (const file of manifest.files) {
    const data = entries.get(file.path)
    if (!data) { problems.push(`缺少 ${file.path}`); continue }
    if (data.length !== file.size) problems.push(`大小不符 ${file.path}`)
    else if (sha256(data) !== file.sha256) problems.push(`哈希不符 ${file.path}`)
  }
  return { manifest, entries, problems }
}

/**
 * 恢复。
 * @param {'overwrite'|'merge'} mode
 */
export function restoreBackup(home, zipPath, { mode = 'merge', dryRun = false } = {}) {
  if (!['overwrite', 'merge'].includes(mode)) throw new Error(`未知恢复模式：${mode}`)
  const { manifest, entries, problems } = inspectBackup(zipPath)
  if (problems.length) throw new Error(`备份校验失败：\n- ${problems.slice(0, 10).join('\n- ')}`)

  const stats = { mode, created: 0, updated: 0, skipped: 0, removed: 0, locked: [], safetyBackup: null }
  if (!dryRun && mode === 'overwrite') {
    stats.safetyBackup = createBackup(home).path
  }

  if (mode === 'overwrite' && !dryRun) {
    for (const file of scan(home)) {
      if (file.rel.startsWith(BACKUP_DIR + '/')) continue
      try { fs.rmSync(file.abs, { force: true }) } catch (error) { stats.locked.push(file.rel) }
    }
    // 清掉空目录
    const prune = (dir) => {
      if (!fs.existsSync(dir)) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const abs = path.join(dir, entry.name)
        prune(abs)
        if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
      }
    }
    prune(home)
  }

  const rootPath = path.resolve(home)
  for (const file of manifest.files) {
    const data = entries.get(file.path)
    const target = path.resolve(home, ...file.path.split('/'))
    // zip slip：manifest 里的路径必须落在库目录内
    if (target !== rootPath && !target.startsWith(rootPath + path.sep)) {
      stats.skipped += 1
      continue
    }
    const exists = fs.existsSync(target)
    if (exists) {
      const current = fs.readFileSync(target)
      if (sha256(current) === file.sha256) {
        stats.skipped += 1
        continue
      }
      if (!dryRun) {
        try { fs.writeFileSync(target, data) } catch (error) { stats.locked.push(file.path); continue }
      }
      stats.updated += 1
    } else {
      if (!dryRun) {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, data)
        } catch (error) {
          stats.locked.push(file.path)
          continue
        }
      }
      stats.created += 1
    }
  }

  if (mode === 'overwrite') {
    const keep = new Set(manifest.files.map((f) => f.path))
    for (const file of scan(home)) {
      if (file.rel.startsWith(BACKUP_DIR + '/')) continue
      if (keep.has(file.rel)) continue
      if (!dryRun) {
        try { fs.rmSync(file.abs, { force: true }) } catch { stats.locked.push(file.rel); continue }
      }
      stats.removed += 1
    }
  }

  return { ...stats, manifest: { createdAt: manifest.createdAt, fileCount: manifest.fileCount } }
}




