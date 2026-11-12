import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HelperProcess } from '../src/helper-process.js'
import { SharedCompanion } from '../src/opencode-shared.js'
import { normalizeSettings } from '../src/opencode-settings.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for shared Helper')
}

test('workspaces share one Helper, combine priorities, and only stop after the last disconnect', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bigfish-shared-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const delivered = []
  let starts = 0
  let stops = 0
  let helper
  const reports = []
  t.mock.method(HelperProcess.prototype, 'start', function () { starts += 1; helper = this })
  t.mock.method(HelperProcess.prototype, 'send', (message) => delivered.push(message))
  t.mock.method(HelperProcess.prototype, 'stop', () => { stops += 1 })
  const createClient = () => {
    const client = new SharedCompanion({
      identity: join(directory, 'settings.json'), settings: normalizeSettings({ balanceEnabled: false, petEngine: 'native' }),
      openUrl: 'http://localhost:4096/', version: 'test', logger: quiet,
      onSettingsChange(report) {
        reports.push(report)
        client.update(normalizeSettings({ ...client.settings, ...report }))
      },
    })
    return client
  }
  const first = createClient()
  const second = createClient()
  t.after(async () => { await first.stop(); await second.stop() })
  await Promise.all([first.start(), second.start()])
  assert.equal(starts, 1)
  assert.equal(delivered.filter((message) => message.kind === 'hello').length, 1)
  helper.options.onSettingsChange({ scale: 1.2, reducedMotion: true })
  await waitFor(() => reports.length === 2 && helper.options.env.DSH_DAFEIYU_SCALE === '1.2')
  first.send({ type: 'event', session: { id: 'same-id', cwd: '/work/first' }, event: { type: 'turn/start' } })
  first.send({ type: 'event', session: { id: 'same-id', cwd: '/work/first' }, event: { type: 'approval/asked', data: { id: 'approval' } } })
  second.send({ type: 'event', session: { id: 'same-id', cwd: '/work/second' }, event: { type: 'turn/start' } })
  second.send({ type: 'event', session: { id: 'same-id', cwd: '/work/second' }, event: { type: 'tool/call', data: { name: 'edit', callId: 'editing' } } })
  await waitFor(() => delivered.some((message) => message.kind === 'tasks' && message.tasks?.length === 2))
  assert.equal(delivered.findLast((message) => message.kind === 'state').state, 'WAITING')
  const tasks = delivered.findLast((message) => message.kind === 'tasks').tasks
  assert.equal(new Set(tasks.map((task) => task.sessionId)).size, 2)
  await first.stop()
  assert.equal(stops, 0)
  await waitFor(() => delivered.findLast((message) => message.kind === 'state')?.state === 'WORKING')
  assert.equal(delivered.findLast((message) => message.kind === 'state').project, 'second')
  second.send({ type: 'event', session: { id: 'same-id' }, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } })
  await waitFor(() => delivered.some((message) => message.state === 'SUCCESS'))
  await second.stop()
  assert.equal(stops, 1)
})

test('separate OpenCode processes share one owner and recover durable state after owner failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bigfish-shared-process-'))
  const messages = []
  const children = []
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill()
    }
    await rm(directory, { recursive: true, force: true })
  })
  const startClient = (workspace) => {
    const child = fork(new URL('./fixtures/shared-companion-client.js', import.meta.url), [], {
      env: { ...process.env, BIGFISH_TEST_IDENTITY: join(directory, 'settings.json'), BIGFISH_TEST_WORKSPACE: `/work/${workspace}` },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    child.on('message', (value) => messages.push({ child, ...value }))
    children.push(child)
    return child
  }
  const first = startClient('first')
  const second = startClient('second')
  await waitFor(() => messages.filter((message) => message.kind === 'ready').length === 2)
  assert.equal(messages.filter((message) => message.kind === 'helper-started').length, 1)
  const owner = messages.find((message) => message.kind === 'helper-started').child
  const survivor = owner === first ? second : first
  survivor.send({ type: 'event', event: { type: 'session.status', properties: { sessionID: 'surviving-session', status: { type: 'busy' } } } })
  await waitFor(() => messages.some((value) => value.message?.state === 'THINKING'))
  survivor.send({ type: 'event', event: { type: 'message.part.updated', properties: { part: {
    sessionID: 'surviving-session', type: 'tool', tool: 'read', callID: 'reading', state: { status: 'running' },
  } } } })
  survivor.send({ type: 'event', event: { type: 'todo.updated', properties: { sessionID: 'surviving-session', todos: [
    { content: 'first step', status: 'completed' }, { content: 'current step', status: 'in_progress' },
  ] } } })
  survivor.send({ type: 'event', event: { type: 'permission.asked', properties: {
    sessionID: 'surviving-session', id: 'approval', permission: 'read',
  } } })
  await waitFor(() => messages.some((value) => value.message?.state === 'WAITING'))
  const boundary = messages.length
  owner.kill()
  await waitFor(() => messages.filter((message) => message.kind === 'helper-started').length === 2)
  await waitFor(() => messages.slice(boundary).some((message) => message.child === survivor && message.message?.state === 'WAITING'))
  const restored = messages.slice(boundary).find((message) => message.message?.state === 'WAITING').message
  assert.equal(restored.progress.completed, 1)
  assert.equal(restored.progress.total, 2)
  assert.equal(messages.slice(boundary).some((message) => ['pulse', 'alert'].includes(message.message?.kind)), false,
    'restoring a workspace must not replay completion or error sounds')
  survivor.send({ type: 'event', event: { type: 'permission.replied', properties: {
    sessionID: 'surviving-session', requestID: 'approval', reply: 'once',
  } } })
  await waitFor(() => messages.slice(boundary).some((message) => message.message?.state === 'WORKING'))
  survivor.send({ type: 'stop' })
  await waitFor(() => messages.some((message) => message.child === survivor && message.kind === 'stopped'))
  assert.equal(messages.filter((message) => message.kind === 'helper-stopped').length, 1)
})
