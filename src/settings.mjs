/**
 * 设置与运行时状态（M2）。
 *
 * 设置落在 kb.json 的 settings 里；运行状态（冷却、计数、上次通知）落在 state.json。
 * 三档模式：review（默认）/ auto（小经验区）/ off。
 */
import fs from 'node:fs'
import path from 'node:path'
import { layout, readConfig, writeConfig } from './config.mjs'
import { contentHash } from './ids.mjs'

export const DEFAULT_SETTINGS = {
  experience: {
    mode: 'review',
    auto: { notifyEvery: 10, notifyAfterDays: 7, maxPerDay: 5 },
    review: { maxPerDay: 3, cooldownHours: 24 },
  },
}

const MODES = new Set(['review', 'auto', 'off'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

export function loadSettings(home) {
  const config = readConfig(home) ?? {}
  const settings = deepMerge(DEFAULT_SETTINGS, config.settings ?? {})
  if (!MODES.has(settings.experience.mode)) settings.experience.mode = 'review'
  return settings
}

export function saveSettings(home, patch) {
  const config = readConfig(home) ?? {}
  config.settings = deepMerge(loadSettings(home), patch)
  writeConfig(config, home)
  return config.settings
}

// ---------- 运行状态 ----------

function statePath(home) {
  return path.join(layout(home).home, 'state.json')
}

export function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

export function loadState(home) {
  const p = statePath(home)
  const base = { day: localDay(), proposalsToday: 0, topics: {}, autoSinceNotify: 0, lastNotifyAt: '', lastNotifiedSeq: 0 }
  if (!fs.existsSync(p)) return base
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { ...base, ...parsed }
  } catch {
    return base
  }
}

export function saveState(home, state) {
  fs.writeFileSync(statePath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function rollDay(state) {
  const day = localDay()
  if (state.day !== day) {
    state.day = day
    state.proposalsToday = 0
    state.topics = {}
  }
  return state
}

/** 审核模式的闸门：同主题冷却 + 每日上限。 */
export function checkReviewGate(home, settings, claim) {
  const state = rollDay(loadState(home))
  const key = contentHash(String(claim ?? ''))
  const cooldownMs = Number(settings.experience.review.cooldownHours) * 3600 * 1000
  const last = state.topics[key]
  if (last && Date.now() - Date.parse(last) < cooldownMs) {
    return { allowed: false, reason: '同一主题还在冷却期', state }
  }
  if (state.proposalsToday >= Number(settings.experience.review.maxPerDay)) {
    return { allowed: false, reason: `今天提议已达上限（${settings.experience.review.maxPerDay} 条）`, state }
  }
  return { allowed: true, state, key }
}

export function noteProposal(home, state, key) {
  state.proposalsToday += 1
  state.topics[key] = new Date().toISOString()
  saveState(home, state)
}

/** 免审模式：小经验区攒够多少条 / 隔了多久，该通知一次。 */
export function shouldNotify(home, settings) {
  const state = loadState(home)
  const every = Number(settings.experience.auto.notifyEvery)
  const days = Number(settings.experience.auto.notifyAfterDays)
  if (state.autoSinceNotify >= every) return { notify: true, reason: `小经验区又攒了 ${state.autoSinceNotify} 条` }
  if (state.lastNotifyAt) {
    const idle = (Date.now() - Date.parse(state.lastNotifyAt)) / 86400000
    if (idle >= days && state.autoSinceNotify > 0) return { notify: true, reason: `距上次通知已 ${Math.floor(idle)} 天` }
  } else if (state.autoSinceNotify > 0) {
    return { notify: state.autoSinceNotify >= every, reason: '' }
  }
  return { notify: false }
}

export function noteAutoApplied(home) {
  const state = loadState(home)
  state.autoSinceNotify += 1
  saveState(home, state)
  return state.autoSinceNotify
}

export function ackNotification(home) {
  const state = loadState(home)
  state.autoSinceNotify = 0
  state.lastNotifyAt = new Date().toISOString()
  saveState(home, state)
  return state
}
