import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from 'dsh-pet/src/host/index.ts'
import { registerBalanceProvider } from 'dsh-pet/src/host/balance/index.ts'
import { createStandaloneContext } from 'dsh-pet/src/standalone/context.ts'
import { listenStandaloneServer } from 'dsh-pet/src/standalone/server.ts'
import { createRequestSecurity } from 'dsh-pet/src/standalone/request-security.ts'
import { configureRuntime, desktopProcesses, killChildren, PACKAGE_ROOT, waitForChildren } from './environment.js'
import { createAttachments } from './attachments.js'

export { PACKAGE_ROOT }
const prefix = '/dsh-pet-7340'

export function upstreamBalance(snapshot) {
  const text = snapshot.summary || snapshot.error || '余额暂不可用'
  // Custom rows preserve the difference between wallet money, key quota and
  // subscription allowance. No fabricated granted/top-up amounts or ratios.
  return { ok: true, provider: 'opencode', shape: 'custom', data: {
    rows: { tag: 'div', children: [{ tag: 'strong', text }] },
    ...(Number.isFinite(snapshot.usedPercent) ? { percent: snapshot.usedPercent }
      : snapshot.available === false ? { percent: 100 } : {}),
  } }
}

export async function createPetEngine({ home, settings, logger = console, request, context = {}, headless = false }) {
  let setup
  let firstDesktopPoll = true
  let replayTimer
  configureRuntime({ home, settings, headless,
    onSetup(value) { setup = value },
    onChild() { firstDesktopPoll = true },
    onDesktopRequest(rawUrl, response) {
      const url = new URL(rawUrl, 'http://localhost')
      if (!firstDesktopPoll || !url.pathname.endsWith('/state')) return
      firstDesktopPoll = false
      const leaf = response.obj?.sections?.workStatus
      if (!['thinking', 'working', 'result', 'waiting'].includes(leaf?.data?.state)) return
      // Upstream's first poll establishes a baseline. Re-publish ongoing work
      // once afterwards, without replaying terminal animations/notifications.
      replayTimer = setTimeout(() => {
        if (setup.state.read().sections.workStatus.counter === leaf.counter) setup.state.writeSection('workStatus', leaf.data)
      }, 100)
      replayTimer.unref?.()
    },
  })
  const dataRoot = join(home, 'dsh-pet')
  mkdirSync(dataRoot, { recursive: true })
  const configFile = join(dataRoot, 'main-config.jsonc')
  // Native settings migrate once. The upstream settings panel becomes the
  // authority for animation, appearance, physics, persona, voice and reminders.
  if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify({
    pets: [{ id: 'main', name: '大肥鱼', size: Math.round(462 * (settings.scale || 1)),
      balanceEnabled: settings.balanceEnabled !== false, whisperEnabled: false,
      workStatusEnabled: true, fixedEnabled: false, display: 'desktop',
      position: { corner: 'bottom-right', marginX: 24, marginY: 40 } }],
    voiceEnabled: false, notificationsEnabled: settings.soundEnabled !== false,
    eventsRefreshSec: { balance: 60, whisper: 300, sleepTalk: 60 },
  }, null, 2) + '\n', { flag: 'wx' })

  let modelContext = context
  const attachments = createAttachments(dataRoot)
  const selection = () => modelContext.selection || { provider: '', model: '' }
  const ai = {
    currentSelection: selection,
    listProviders: () => modelContext.providers || [],
    listModels: async (id) => modelContext.providers?.find((item) => item.id === id)?.models || [],
    resolveModelInfo: async () => ({ reasoning: undefined }),
    async *stream(input) {
      const response = await request('chat', { ...input, messages: input.messages.map((message) => ({ ...message,
        content: Array.isArray(message.content) ? message.content.map((part) => part.type === 'image'
          ? attachments.materialize(part.attachment) : part) : message.content,
      })) })
      yield { type: 'text', text: response.text }
    },
    isReady: () => Boolean(selection().provider && selection().model),
    balanceAuth: () => ({ provider: 'opencode', apiKey: '' }), dispose() {},
  }
  const routes = []
  let port = 0
  const security = createRequestSecurity()
  const standalone = createStandaloneContext({ port: () => port, logger, routes, ai,
    authenticatedUrl: security.authenticatedUrl,
  })
  standalone.ctx.provide('attachments', attachments)
  const disposeBalance = registerBalanceProvider({ id: 'opencode', fetch: async () => upstreamBalance(await request('balance')) })
  const server = await listenStandaloneServer({
    routes, logger, security, port: 0,
    status: () => ({ name: 'opencode-dsh-pet', engine: 'dsh-pet', version: '0.4.7', singlePet: true }),
  })
  port = server.port
  apply(standalone.ctx)
  if (standalone.failures.length) {
    await standalone.dispose(); await server.close(); disposeBalance()
    throw new Error('dsh-pet 初始化失败，请查看运行日志。')
  }
  const settingsUrl = security.authenticatedUrl(`http://127.0.0.1:${port}`)
  const manifest = join(dataRoot, 'opencode-runtime.json')
  writeFileSync(manifest, JSON.stringify({ port, settingsUrl, pid: process.pid, engine: 'dsh-pet@0.4.7' }, null, 2) + '\n', { mode: 0o600 })
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${prefix}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-dsh-pet-token': security.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
    })
    if (!response.ok) throw new Error(`桌宠接口不可用（${response.status}）`)
    return response.status === 204 ? undefined : response.json()
  }
  let closed = false
  let workTimer
  return {
    port, settingsUrl, call, kill: killChildren, desktopProcesses,
    updateContext(value) {
      const changed = value.workspace !== modelContext.workspace
      modelContext = value
      if (changed && !closed) void call('/balance', 'POST', {}).catch(() => {})
    },
    async send(message) {
      if (closed) return
      if (message.kind === 'alert' || message.kind === 'pulse') {
        const event = message.kind === 'alert' ? { type: 'approval/asked', data: { reason: 'OpenCode 等待确认' } }
          : { type: 'turn/end', data: { reason: { kind: message.state === 'SUCCESS' ? 'completed' : 'error' } } }
        setup.state.writeSection('notify', { type: 'session/event', event })
      }
      const states = { THINKING: 'thinking', WORKING: 'working', WAITING: 'waiting', ERROR: 'error', SUCCESS: 'success' }
      if (['state', 'pulse', 'task'].includes(message.kind)) {
        if (message.kind === 'task') {
          const state = await call('/state')
          const current = state.sections.workStatus.data?.state
          if (current) await call('/work-status', 'POST', { state: current, task: String(message.detail || message.task || '').slice(0, 40) })
          return
        }
        clearTimeout(workTimer)
        const state = states[message.state]
        if (state) await call('/work-status', 'POST', { state, task: String(message.detail || message.message || '').slice(0, 40) })
        else await call('/work-status', 'DELETE')
        if (message.kind === 'pulse') {
          workTimer = setTimeout(() => {
            void this.send({ kind: 'state', state: message.resumeState || 'IDLE', detail: message.resumeDetail }).catch(() => {})
          }, message.ttlMs || 2200)
          workTimer.unref?.()
        }
      }
      // Polling/manual refresh use the same bridge to the selected OpenCode
      // workspace. Native balance messages are handled there, not polled twice.
    },
    async stop() {
      if (closed) return
      closed = true
      clearTimeout(workTimer)
      clearTimeout(replayTimer)
      disposeBalance()
      await standalone.dispose()
      await waitForChildren()
      await server.close()
      try { unlinkSync(manifest) } catch {}
    },
  }
}
