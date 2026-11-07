import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as entry from '../src/opencode.js'
import { HelperProcess } from '../src/helper-process.js'
import { loadSettings, normalizeSettings, resolveOpenUrl, settingsPaths } from '../src/opencode-settings.js'

test('OpenCode module exposes a single plugin function and no DSH runtime exports', () => {
  assert.deepEqual(Object.keys(entry), ['default'])
  assert.equal(typeof entry.default, 'function')
})

test('plugin loads settings, serializes events, persists native settings, and disposes its helper', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-bigfish-'))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = directory
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
    await rm(directory, { recursive: true, force: true })
  })
  await writeFile(join(directory, 'dafeiyu.json'), JSON.stringify({ scale: 0.8, balanceEnabled: false }))
  let bridge
  const delivered = []
  let stopped
  t.mock.method(HelperProcess.prototype, 'start', function () { bridge = this })
  t.mock.method(HelperProcess.prototype, 'send', (message) => delivered.push(message))
  t.mock.method(HelperProcess.prototype, 'stop', (reason) => { stopped = reason })
  const exitListeners = process.listenerCount('exit')
  const hooks = await entry.default({
    directory, serverUrl: new URL('http://localhost:4567/'),
    client: { session: { async get({ path }) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { data: { id: path.id, directory, ...(path.id === 'child' ? { parentID: 'one' } : {}) } }
    } } },
  })
  t.after(() => hooks.event({ event: { type: 'global.disposed' } }))
  await hooks.config({})
  assert.equal(delivered[0].host, 'opencode')
  assert.equal(bridge.options.env.DSH_DAFEIYU_SCALE, '0.8')
  assert.equal(bridge.options.env.DSH_DAFEIYU_OPEN_LABEL, '打开 OpenCode')
  assert.equal(delivered.find((message) => message.kind === 'config').openUrl, 'http://localhost:4567/')
  await Promise.all(['busy', 'idle'].map((type) => hooks.event({
    event: { type: 'session.status', properties: { sessionID: 'one', status: { type } } },
  })))
  assert.ok(delivered.some((message) => message.state === 'THINKING'))
  assert.equal(delivered.filter((message) => message.state === 'SUCCESS').length, 1)
  const count = delivered.length
  await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'child', status: { type: 'busy' } } } })
  assert.equal(delivered.length, count)
  bridge.options.onSettingsChange({ scale: 1.2, reducedMotion: true })
  assert.equal(bridge.options.env.DSH_DAFEIYU_SCALE, '1.2')
  const saved = JSON.parse(await readFile(join(directory, 'dafeiyu-user-settings.json'), 'utf8'))
  assert.equal(saved.overrides.scale.value, 1.2)
  await hooks.event({ event: { type: 'server.instance.disposed', properties: { directory: '/unrelated' } } })
  assert.equal(stopped, undefined)
  await hooks.event({ event: { type: 'server.instance.disposed', properties: { directory } } })
  assert.equal(stopped, 'opencode-stop')
  assert.equal(process.listenerCount('exit'), exitListeners)
  const afterStop = delivered.length
  await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'one', status: { type: 'busy' } } } })
  assert.equal(delivered.length, afterStop)
})

test('disabled plugin registers no hooks or helper', async () => {
  const hooks = await entry.default({ directory: tmpdir() }, { enabled: false })
  assert.deepEqual(hooks, {})
})

test('OpenCode saved provider credentials query API balance without exposing the key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-bigfish-balance-'))
  const previousDirectory = process.env.OPENCODE_CONFIG_DIR
  const previousKey = process.env.DEEPSEEK_API_KEY
  process.env.OPENCODE_CONFIG_DIR = directory
  delete process.env.DEEPSEEK_API_KEY
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousDirectory
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
    await rm(directory, { recursive: true, force: true })
  })
  const delivered = []
  t.mock.method(HelperProcess.prototype, 'start', () => {})
  t.mock.method(HelperProcess.prototype, 'send', (message) => delivered.push(message))
  t.mock.method(HelperProcess.prototype, 'stop', () => {})
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url.href, 'http://127.0.0.1:4567/user/balance')
    assert.equal(init.headers.Authorization, 'Bearer smoke-provider-key')
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{
      currency: 'CNY', total_balance: '10.50', granted_balance: '0', topped_up_balance: '10.50',
    }] }))
  })
  const hooks = await entry.default({ directory, client: {
    config: { async providers() { return { data: { providers: [{ id: 'deepseek', key: 'smoke-provider-key' }] } } } },
  } })
  t.after(() => hooks.event({ event: { type: 'global.disposed' } }))
  await hooks.config({ provider: { deepseek: { options: { baseURL: 'http://127.0.0.1:4567/v1' } } } })
  const deadline = Date.now() + 1000
  while (!delivered.some((message) => message.kind === 'balance' && message.status === 'ready') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const balance = delivered.find((message) => message.kind === 'balance' && message.status === 'ready')
  assert.equal(balance?.balances[0].total, '10.50')
  assert.equal(JSON.stringify(delivered).includes('smoke-provider-key'), false)
})

test('settings have separate OpenCode storage, clamp ranges and reject invalid values', () => {
  const paths = settingsPaths('/project', { XDG_CONFIG_HOME: '/config', DSH_HOME: '/dsh' }, '/home')
  assert.match(paths.overrides, /opencode[\\/]dafeiyu-user-settings\.json$/)
  assert.equal(paths.files.length, 2)
  assert.deepEqual(normalizeSettings({
    scale: 99, bubbleScale: 0, enabled: 'false', activityLevel: 'unknown',
    soundStates: ['APPROVAL', 'unknown', 'APPROVAL'], openUrl: 'javascript:alert(1)',
  }), {
    enabled: true, scale: 1.4, bubbleScale: 0.8, activityLevel: 'normal',
    reducedMotion: false, soundEnabled: true, soundStates: ['APPROVAL'],
    bubbleMode: 'always', bubbleStates: ['SUCCESS', 'ERROR', 'WAITING'],
    includeSubagents: false, balanceEnabled: true, openUrl: '',
    balanceType: 'auto', balanceProvider: '',
  })
})

test('native menu uses a reachable host address and never exposes port zero', () => {
  assert.equal(resolveOpenUrl({}, new URL('http://0.0.0.0:0/')), 'http://127.0.0.1:4096/')
  assert.equal(resolveOpenUrl({}, new URL('http://[::]:4567/')), 'http://[::1]:4567/')
  assert.equal(resolveOpenUrl({ openUrl: 'opencode://open' }, new URL('http://localhost:0/')), 'opencode://open')
})

test('malformed settings fall back and explicit options override file values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-bigfish-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const good = join(directory, 'global.json')
  const bad = join(directory, 'project.json')
  await writeFile(good, '{"scale":0.7,"soundEnabled":false}')
  await writeFile(bad, '{')
  const warnings = []
  const settings = loadSettings([good, bad], { scale: 1.1 }, (message) => warnings.push(message))
  assert.equal(settings.scale, 1.1)
  assert.equal(settings.soundEnabled, false)
  assert.equal(warnings.length, 1)
})
