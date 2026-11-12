import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, statSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CompanionReducer, statePriority } from './companion-reducer.js'
import { HelperProcess } from './helper-process.js'
import { DshPetHelper } from './dsh-pet-helper.js'
import { normalizeSettings } from './opencode-settings.js'
import { createMessage } from './protocol.js'

const MAX_FRAME_BYTES = 1024 * 1024
const owners = new Map()

export function companionEndpoint(identity) {
  const key = createHash('sha256').update(resolve(identity)).digest('hex').slice(0, 24)
  return process.platform === 'win32' ? `\\\\.\\pipe\\opencode-dafeiyu-${key}`
    : join(tmpdir(), `opencode-dafeiyu-${process.getuid?.() ?? 'user'}-${key}.sock`)
}

function readFrames(socket, receive) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return socket.destroy()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try { receive(JSON.parse(line)) } catch { socket.destroy(); return }
    }
  })
}

function writeFrame(socket, value) {
  if (!socket || socket.destroyed || !socket.writable) return
  // Keep a stuck local subscriber from building an unbounded output buffer.
  if (socket.writableLength > MAX_FRAME_BYTES) return socket.destroy()
  socket.write(`${JSON.stringify(value)}\n`)
}

function helperEnvironment(settings, openUrl) {
  return {
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
  }
}

class CompanionOwner {
  constructor(endpoint, logger, identity) {
    this.endpoint = endpoint
    this.logger = logger
    this.identity = identity
    this.requests = new Map()
    this.clients = new Map()
    this.reducer = new CompanionReducer({ includeSubagents: true, hostName: 'OpenCode' })
    this.server = createServer((socket) => this.accept(socket))
    this.server.on('error', () => {})
    this.onExit = () => {
      this.helper?.child?.stdin?.destroy()
      this.helper?.child?.kill()
      this.helper?.kill?.()
    }
  }

  listen() {
    return new Promise((resolveListen, reject) => {
      const failed = (error) => reject(error)
      this.server.once('error', failed)
      this.server.listen(this.endpoint, () => {
        this.server.removeListener('error', failed)
        if (process.platform !== 'win32') {
          try { chmodSync(this.endpoint, 0o600) } catch {}
        }
        this.server.unref()
        process.once('exit', this.onExit)
        this.idleTimer = setTimeout(() => { if (!this.clients.size && !this.helper) this.stop() }, 5000)
        this.idleTimer.unref?.()
        resolveListen()
      })
    })
  }

  accept(socket) {
    if (this.closing) return socket.end()
    const client = { id: randomUUID(), socket, initialized: false }
    socket.on('error', () => {})
    socket.once('close', () => this.detach(client))
    readFrames(socket, (frame) => {
      if (frame.type === 'init' && !client.initialized) {
        clearTimeout(this.idleTimer)
        client.initialized = true
        client.settings = normalizeSettings(frame.settings)
        client.openUrl = frame.openUrl
        client.context = frame.context || {}
        this.clients.set(client.id, client)
        if (!this.helper) {
          const Helper = client.settings.petEngine === 'native' ? HelperProcess : DshPetHelper
          this.helper = new Helper({
            identity: this.identity, settings: client.settings, context: client.context,
            request: (action, data) => this.request(action, data),
            env: helperEnvironment(client.settings, client.openUrl),
            onSettingsChange: (report) => {
              for (const peer of this.clients.values()) writeFrame(peer.socket, { type: 'settings', report })
            },
          }, this.logger)
          this.helper.start()
          this.helper.send(createMessage('hello', { host: 'opencode', pluginVersion: frame.version, message: '大肥鱼已连接 OpenCode' }))
          this.helper.send(createMessage('state', {
            state: 'IDLE', phase: 'plugin-start', stage: '等待任务',
            message: '我在这儿等新任务哦', detail: 'OpenCode · 等待下一次任务',
          }))
        }
        writeFrame(socket, { type: 'ready' })
        this.select()
        return
      }
      if (!client.initialized) return socket.destroy()
      const sessionID = (id) => `${client.id}/${id}`
      switch (frame.type) {
        case 'event':
          if (!frame.session?.id || !frame.event?.type) break
          this.deliver(this.reducer.handle({ ...frame.session, id: sessionID(frame.session.id) }, frame.event))
          break
        case 'snapshot':
          if (!Array.isArray(frame.sessions) || frame.sessions.length > 256) break
          for (const record of frame.sessions) this.deliver(this.reducer.restoreSession(sessionID(record.id), record))
          break
        case 'dispose-session':
          this.deliver(this.reducer.disposeSession({ id: sessionID(frame.id) }))
          break
        case 'config':
          client.settings = normalizeSettings(frame.settings)
          client.openUrl = frame.openUrl
          client.context = frame.context || client.context
          if (client === this.selected) this.sendConfig()
          break
        case 'response': {
          const pending = this.requests.get(frame.id)
          if (pending && pending.client === client) {
            this.requests.delete(frame.id)
            clearTimeout(pending.timer)
            if (frame.ok) {
              if (pending.action === 'balance') {
                client.balance = frame.result
                this.helper.send(createMessage('balance', frame.result))
              }
              pending.resolve(frame.result)
            }
            else pending.reject(new Error(frame.error || 'OpenCode 未能完成桌宠请求。'))
          }
          break
        }
        case 'balance':
          client.balance = frame.snapshot
          if (client === this.selected) this.helper.send(createMessage('balance', frame.snapshot))
          break
        case 'detach':
          this.detach(client)
          writeFrame(socket, { type: 'detached' })
          socket.end()
          break
      }
    })
  }

  deliver(messages) {
    this.select()
    for (const message of messages) this.helper?.send(message)
  }

  select() {
    const records = [...this.reducer.sessions.values()].sort((left, right) =>
      (statePriority[right.state] ?? 0) - (statePriority[left.state] ?? 0)
      || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    const selected = this.clients.get(records[0]?.id.split('/')[0]) ?? this.clients.values().next().value
    if (selected === this.selected) return
    const previous = this.selected
    this.selected = selected
    if (previous) writeFrame(previous.socket, { type: 'selected', value: false })
    if (selected) {
      this.sendConfig()
      this.helper.send(createMessage('balance', selected.balance ?? {
        status: selected.settings.balanceEnabled ? 'loading' : 'disabled', balances: [],
        summary: selected.settings.balanceEnabled ? '正在查询余额…' : '',
      }))
      writeFrame(selected.socket, { type: 'selected', value: true })
    }
  }

  sendConfig() {
    const { settings, openUrl } = this.selected
    this.helper.options.env = helperEnvironment(settings, openUrl)
    this.helper.options.context = this.selected.context
    this.helper.send(createMessage('config', { ...settings, openUrl, openLabel: '打开 OpenCode' }))
  }

  request(action, data) {
    const client = this.selected || this.clients.values().next().value
    if (!client) return Promise.reject(new Error('没有已连接的 OpenCode 工作区。'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error('OpenCode 桌宠请求超时。'))
      }, 100000)
      timer.unref?.()
      this.requests.set(id, { client, action, resolve, reject, timer })
      writeFrame(client.socket, { type: 'request', id, action, data })
    })
  }

  detach(client) {
    if (!this.clients.delete(client.id)) return
    for (const [id, pending] of this.requests) {
      if (pending.client !== client) continue
      clearTimeout(pending.timer)
      pending.reject(new Error('对应的 OpenCode 工作区已关闭。'))
      this.requests.delete(id)
    }
    for (const record of [...this.reducer.sessions.values()]) {
      if (record.id.startsWith(`${client.id}/`)) this.deliver(this.reducer.disposeSession({ id: record.id }))
    }
    this.select()
    if (!this.clients.size) this.stop()
  }

  stop() {
    if (this.closing) return
    this.closing = true
    clearTimeout(this.idleTimer)
    const child = this.helper?.child
    const stopping = this.helper?.stop('opencode-stop')
    const finish = () => {
      process.removeListener('exit', this.onExit)
      this.server.close(() => { if (owners.get(this.endpoint) === this) owners.delete(this.endpoint) })
    }
    // Hold the IPC address until the previous Helper has actually exited.
    if (stopping?.then) void stopping.then(finish, finish)
    else if (child && child.exitCode === null) child.once('exit', finish)
    else finish()
  }
}

async function ensureOwner(endpoint, logger, identity) {
  if (owners.has(endpoint)) return
  const owner = new CompanionOwner(endpoint, logger, identity)
  owners.set(endpoint, owner)
  try { await owner.listen() } catch (error) {
    if (owners.get(endpoint) === owner) owners.delete(endpoint)
    owner.server.close()
    if (error.code !== 'EADDRINUSE') throw error
  }
}

// Every workspace keeps a small IPC connection. The first local process owns
// one native Helper; all other workspaces/processes join it through this pipe.
export class SharedCompanion {
  constructor({ identity, settings, openUrl, version, logger = console, snapshot = () => [], onSettingsChange, onSelection, context = {}, onRequest }) {
    this.endpoint = companionEndpoint(identity)
    this.identity = identity
    this.context = context
    this.onRequest = onRequest
    this.settings = settings
    this.openUrl = openUrl
    this.version = version
    this.logger = logger
    this.snapshot = snapshot
    this.onSettingsChange = onSettingsChange
    this.onSelection = onSelection
    this.queue = []
    this.closed = false
  }

  start() {
    return new Promise((resolveStart, reject) => {
      this.resolveStart = resolveStart
      this.rejectStart = reject
      this.startTimeout = setTimeout(() => {
        void this.stop()
        reject(new Error('Shared BigFish connection timed out'))
      }, 10000)
      this.startTimeout.unref?.()
      this.connect()
    })
  }

  connect() {
    if (this.closed) return
    const socket = createConnection(this.endpoint)
    this.socket = socket
    let connectionError
    socket.once('connect', () => writeFrame(socket, {
      type: 'init', settings: this.settings, openUrl: this.openUrl, version: this.version, context: this.context,
    }))
    socket.on('error', (error) => { connectionError = error })
    socket.once('close', () => {
      this.ready = false
      this.onSelection?.(false)
      if (this.closed) return this.resolveStop?.()
      void this.reconnect(connectionError)
    })
    readFrames(socket, (frame) => {
      if (frame.type === 'ready') {
        this.ready = true
        clearTimeout(this.startTimeout)
        // Durable snapshots restore work after owner process failure without
        // replaying stale completion pulses or re-chiming old permissions.
        writeFrame(socket, { type: 'snapshot', sessions: this.snapshot() })
        for (const value of this.queue.splice(0)) writeFrame(socket, value)
        this.resolveStart?.()
      } else if (frame.type === 'selected') this.onSelection?.(frame.value === true)
      else if (frame.type === 'settings') this.onSettingsChange?.(frame.report)
      else if (frame.type === 'request') {
        void Promise.resolve().then(() => this.onRequest?.(frame.action, frame.data)).then(
          (result) => writeFrame(socket, { type: 'response', id: frame.id, ok: true, result }),
          (error) => writeFrame(socket, { type: 'response', id: frame.id, ok: false, error: error.message }),
        )
      }
      else if (frame.type === 'detached') {
        socket.end()
        this.resolveStop?.()
      }
    })
  }

  async reconnect(error) {
    if (this.closed) return
    try {
      if (process.platform !== 'win32' && error?.code === 'ECONNREFUSED') {
        // Unix leaves a socket file behind after SIGKILL. Never unlink a fresh
        // listener that another client may still be bringing up.
        try { if (Date.now() - statSync(this.endpoint).mtimeMs > 2000) unlinkSync(this.endpoint) } catch {}
      }
      await ensureOwner(this.endpoint, this.logger, this.identity)
    } catch {
      this.logger.warn?.('无法连接共享大肥鱼，稍后重试。')
    }
    if (this.closed) return
    this.retry = setTimeout(() => this.connect(), 100)
    this.retry.unref?.()
  }

  send(value) {
    if (this.closed) return
    if (this.ready) writeFrame(this.socket, value)
    else {
      if (this.queue.length >= 256) this.queue.shift()
      this.queue.push(value)
    }
  }

  update(settings, openUrl = this.openUrl, context = this.context) {
    this.settings = settings
    this.openUrl = openUrl
    this.context = context
    this.send({ type: 'config', settings, openUrl, context })
  }

  stop() {
    if (this.closed) return this.stopped
    this.closed = true
    clearTimeout(this.startTimeout)
    clearTimeout(this.retry)
    this.onSelection?.(false)
    this.stopped = new Promise((resolveStop) => {
      this.resolveStop = resolveStop
      if (!this.socket || this.socket.destroyed) return resolveStop()
      if (this.ready) writeFrame(this.socket, { type: 'detach' })
      else this.socket.destroy()
      const deadline = setTimeout(() => { this.socket.destroy(); resolveStop() }, 1500)
      deadline.unref?.()
      this.socket.once('close', () => clearTimeout(deadline))
    })
    return this.stopped
  }
}
