import { readFileSync } from 'node:fs'
import { SharedCompanion } from './opencode-shared.js'
import { OpenCodeEvents } from './opencode-events.js'
import { loadSettings, resolveOpenUrl, settingsPaths } from './opencode-settings.js'
import { createUserSettingsStore } from './user-settings.js'
import { createBalanceMonitor } from './balance.js'
import { createOpenCodeBalanceQuery } from './opencode-balance.js'
import { petChat, petModelContext } from './opencode-pet-actions.js'

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
  const events = new OpenCodeEvents({
    directory, includeSubagents: settings.includeSubagents,
    onEvent: (session, event) => bridge?.send({ type: 'event', session, event }),
    onDispose: (id) => bridge?.send({ type: 'dispose-session', id }),
  })
  let hostConfig = {}
  let bridge
  let stopped = false
  let pending = Promise.resolve()
  let currentModel
  const ignoredSessions = new Set()
  const petRequests = new AbortController()
  const modelContext = () => ({ ...petModelContext(hostConfig, currentModel), workspace: directory })
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (message) => log(level, message)]))
  const openUrl = resolveOpenUrl(settings, serverUrl)
  const balanceQuery = createOpenCodeBalanceQuery({ client, directory, getConfig: () => hostConfig, getSettings: () => settings })
  const balance = createBalanceMonitor({
    query: balanceQuery,
    onChange(snapshot) {
      const error = snapshot.status === 'not-configured'
        ? '请在 OpenCode 中配置余额服务商的 API Key 和地址，并检查大肥鱼的 balanceType / balanceProvider 设置。'
        : snapshot.error?.replaceAll('DSH', 'OpenCode').replace('，或登录 DeepSeek 账户', '')
      bridge?.send({ type: 'balance', snapshot: { ...snapshot, error } })
    },
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    petRequests.abort()
    balance.stop()
    return bridge?.stop()
  }
  const start = async () => {
    if (bridge || stopped) return
    bridge = new SharedCompanion({
      identity: paths.overrides, settings, openUrl, version, logger, context: modelContext(),
      snapshot: () => events.snapshot(),
      onSettingsChange(report) {
        store.record(report, base)
        settings = store.apply(base)
        bridge.update(settings)
      },
      onSelection: (selected) => balance.configure(settings.petEngine === 'native' && selected && !stopped && settings.balanceEnabled, 'api-key'),
      async onRequest(action, request) {
        if (action === 'balance') {
          // Upstream owns periodic/manual refresh in dsh-pet mode.
          const result = await balanceQuery('api-key', AbortSignal.timeout(10000))
          const { balanceSummary } = await import('./balance.js')
          return { ...result, status: 'ready', summary: balanceSummary({ ...result, status: 'ready' }) }
        }
        if (action === 'chat') return petChat({ client, directory, context: modelContext(), request, ignoredSessions, signal: petRequests.signal })
        throw new Error('不支持的桌宠请求。')
      },
    })
    await bridge.start()
  }
  return {
    async config(config) {
      hostConfig = config
      try { await start() } catch { await stop(); log('error', '大肥鱼启动失败，请检查 Helper 日志。') }
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
        if (ignoredSessions.has(id)) return
        if (event.type === 'message.updated' && event.properties?.info?.role === 'user') {
          const model = event.properties.info.model
          if (model?.providerID && model?.modelID) {
            currentModel = `${model.providerID}/${model.modelID}`
            bridge?.update(settings, openUrl, modelContext())
          }
        }
        if (id && !events.sessions.has(id) && !event.type.startsWith('session.created') && client?.session?.get) {
          try {
            const result = await client.session.get({ path: { id }, query: { directory }, signal: AbortSignal.timeout(3000) })
            if (result.data) events.setSession(result.data)
          } catch {}
        }
        if (stopped) return
        events.handle(event)
      }).catch(() => { log('warn', '大肥鱼未能处理一条 OpenCode 事件。') })
      await pending
    },
  }
}
