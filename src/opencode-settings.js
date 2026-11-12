import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const defaults = Object.freeze({
  enabled: true, scale: 1, bubbleScale: 1, activityLevel: 'normal',
  reducedMotion: false, soundEnabled: true, soundStates: ['SUCCESS', 'ERROR'],
  bubbleMode: 'always', bubbleStates: ['SUCCESS', 'ERROR', 'WAITING'],
  includeSubagents: false, balanceEnabled: true, openUrl: '',
  balanceType: 'auto', balanceProvider: '',
  petEngine: 'dsh-pet', petId: 'main',
})

export function settingsPaths(directory, env = process.env, home = homedir()) {
  const configRoot = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
  return {
    files: env.OPENCODE_DAFEIYU_CONFIG ? [resolve(env.OPENCODE_DAFEIYU_CONFIG)]
      : [join(configRoot, 'dafeiyu.json'), join(directory, '.opencode', 'dafeiyu.json')],
    overrides: join(configRoot, 'dafeiyu-user-settings.json'),
  }
}

export function normalizeSettings(input = {}) {
  const value = { ...defaults }
  for (const key of ['enabled', 'reducedMotion', 'soundEnabled', 'includeSubagents', 'balanceEnabled']) {
    if (typeof input[key] === 'boolean') value[key] = input[key]
  }
  for (const [key, low, high] of [['scale', 0.55, 1.4], ['bubbleScale', 0.8, 1.2]]) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) value[key] = Math.min(high, Math.max(low, input[key]))
  }
  for (const [key, choices] of [
    ['activityLevel', ['quiet', 'normal', 'lively']],
    ['bubbleMode', ['always', 'hidden', 'custom']],
    ['balanceType', ['auto', 'deepseek', 'sub2api']],
    ['petEngine', ['dsh-pet', 'native']],
  ]) {
    if (choices.includes(input[key])) value[key] = input[key]
  }
  if (input.balanceType === 'subapi2') value.balanceType = 'sub2api'
  if (typeof input.balanceProvider === 'string') value.balanceProvider = input.balanceProvider.trim()
  if (typeof input.petId === 'string' && input.petId.trim()) value.petId = input.petId.trim()
  for (const [key, choices] of [
    ['soundStates', ['SUCCESS', 'ERROR', 'APPROVAL']],
    ['bubbleStates', ['IDLE', 'THINKING', 'WORKING', 'WAITING', 'SUCCESS', 'ERROR']],
  ]) {
    if (Array.isArray(input[key])) value[key] = [...new Set(input[key].filter((state) => choices.includes(state)))]
  }
  if (typeof input.openUrl === 'string' && /^(https?:|opencode:)/.test(input.openUrl)) value.openUrl = input.openUrl
  return value
}

export function loadSettings(files, options = {}, warn = () => {}) {
  let merged = {}
  for (const file of files) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object')
      merged = { ...merged, ...value }
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`无法读取大肥鱼设置 ${file}，使用其他设置或默认值。`)
    }
  }
  return normalizeSettings({ ...merged, ...options })
}

export function resolveOpenUrl(settings, serverUrl) {
  if (settings.openUrl) return settings.openUrl
  const url = new URL(serverUrl?.href || 'http://127.0.0.1:4096/')
  // OpenCode 1.2.27 can expose the requested port (0) rather than the port
  // assigned by the OS. Use the conventional address until openUrl is set.
  if (url.port === '0') url.port = '4096'
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  if (url.hostname === '[::]') url.hostname = '[::1]'
  return url.href
}
