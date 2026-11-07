import { readFileSync } from 'node:fs'
import { HelperProcess } from './helper-process.js'
import { OpenCodeEvents } from './opencode-events.js'
import { loadSettings, resolveOpenUrl, settingsPaths } from './opencode-settings.js'
import { createUserSettingsStore } from './user-settings.js'
import { createBalanceMonitor } from './balance.js'
import { createOpenCodeBalanceQuery } from './opencode-balance.js'
import { createMessage } from './protocol.js'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// Keep only the plugin function exported: OpenCode 1.x invokes every export.
// Dependencies are local or built into Node, so the DSH runtime is not required.
export default async function BigFishPlugin({ client, directory, serverUrl }, options = {}) {
  const log = (level, message) => {
    try {
      void Promise.resolve(client?.app?.log?.({ body: { service: 'opencode-dafeiyu', level, message } })).catch(() => {})
    } catch {}
  }
  const paths = settingsPaths(directory)
  const base = loadSettings(paths.files, options, (message) => log('warn', message))
  if (!base.enabled) return {}
  const store = createUserSettingsStore(paths.overrides, { warn: (message) => log('warn', message) })
  let settings = store.apply(base)
  const events = new OpenCodeEvents({ directory, includeSubagents: settings.includeSubagents })
  let hostConfig = {}
  let bridge
  let stopped = false
  let pending = Promise.resolve()
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (message) => log(level, message)]))
  const openUrl = resolveOpenUrl(settings, serverUrl)
  const helperEnvironment = () => ({
    DSH_DAFEIYU_SCALE: String(settings.scale),
    DSH_DAFEIYU_BUBBLE_SCALE: String(settings.bubbleScale),
    DSH_DAFEIYU_ACTIVITY_LEVEL: settings.activityLevel,
    DSH_DAFEIYU_REDUCED_MOTION: settings.reducedMotion ? '1' : '0',
    DSH_DAFEIYU_SOUND_ENABLED: settings.soundEnabled ? '1' : '0',
    DSH_DAFEIYU_SOUND_STATES: settings.soundStates.join(','),
    DSH_DAFEIYU_BUBBLE_MODE: settings.bubbleMode,
    DSH_DAFEIYU_BUBBLE_STATES: settings.bubbleStates.join(','),
    DSH_DAFEIYU_WEBUI_URL: openUrl,
    DSH_DAFEIYU_OPEN_LABEL: '打开 OpenCode',
    DSH_DAFEIYU_HOST_NAME: 'OpenCode',
  })
  const sendConfig = () => {
    if (!bridge) return
    bridge.options.env = helperEnvironment()
    bridge.send(createMessage('config', { ...settings, openUrl, openLabel: '打开 OpenCode' }))
  }
  const balance = createBalanceMonitor({
    query: createOpenCodeBalanceQuery({ client, directory, getConfig: () => hostConfig, getSettings: () => settings }),
    onChange(snapshot) {
      const error = snapshot.status === 'not-configured'
        ? '请在 OpenCode 中配置余额服务商的 API Key 和地址，并检查大肥鱼的 balanceType / balanceProvider 设置。'
        : snapshot.error?.replaceAll('DSH', 'OpenCode').replace('，或登录 DeepSeek 账户', '')
      bridge?.send(createMessage('balance', { ...snapshot, error }))
    },
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    balance.stop()
    bridge?.stop('opencode-stop')
    process.removeListener('exit', onExit)
    process.removeListener('beforeExit', stop)
  }
  const onExit = () => {
    // Normal instance disposal uses SHUTDOWN. At process exit the event loop
    // cannot flush a handshake, so close the owned child's input immediately.
    bridge?.child?.stdin?.destroy()
    bridge?.child?.kill()
  }
  const start = () => {
    if (bridge || stopped) return
    bridge = new HelperProcess({
      env: helperEnvironment(),
      onSettingsChange(report) {
        store.record(report, base)
        settings = store.apply(base)
        sendConfig()
      },
    }, logger)
    process.once('exit', onExit)
    process.once('beforeExit', stop)
    bridge.start()
    bridge.send(createMessage('hello', { host: 'opencode', pluginVersion: version, message: '大肥鱼已连接 OpenCode' }))
    bridge.send(createMessage('state', {
      state: 'IDLE', phase: 'plugin-start', stage: '等待任务',
      message: '我在这儿等新任务哦', detail: 'OpenCode · 等待下一次任务',
    }))
    sendConfig()
    balance.configure(settings.balanceEnabled, 'api-key')
  }
  return {
    async config(config) {
      hostConfig = config
      try { start() } catch { stop(); log('error', '大肥鱼启动失败，请检查 Helper 日志。') }
    },
    async event({ event }) {
      if (event.type === 'server.instance.disposed' && event.properties?.directory === directory) return stop()
      if (event.type === 'global.disposed') return stop()
      if (stopped || !events.observes(event)) return
      // Bus subscribers are concurrent. Serialize metadata lookup and reduction
      // so a fast idle event cannot overtake a tool or permission event.
      pending = pending.then(async () => {
        if (stopped) return
        const id = events.sessionID(event)
        if (id && !events.sessions.has(id) && !event.type.startsWith('session.created') && client?.session?.get) {
          try {
            const result = await client.session.get({ path: { id }, query: { directory }, signal: AbortSignal.timeout(3000) })
            if (result.data) events.setSession(result.data)
          } catch {}
        }
        if (stopped) return
        for (const message of events.handle(event)) bridge?.send(message)
      }).catch(() => { log('warn', '大肥鱼未能处理一条 OpenCode 事件。') })
      await pending
    },
  }
}
