import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenCodeEvents } from '../src/opencode-events.js'

const bus = (type, properties) => ({ type, properties })
const status = (type, sessionID = 'one') => bus('session.status', { sessionID, status: { type } })
const tool = (callID, state, name = 'read', sessionID = 'one') => bus('message.part.updated', {
  part: { type: 'tool', sessionID, callID, tool: name, state: { status: state } },
})
const lastState = (messages) => messages.findLast((message) => message.kind === 'state')

test('OpenCode tool steps, duplicate idle events, and todo progress form one turn', () => {
  const adapter = new OpenCodeEvents({ directory: 'C:\\work\\project' })
  assert.equal(lastState(adapter.handle(status('busy'))).state, 'THINKING')
  assert.equal(lastState(adapter.handle(tool('read-one', 'pending'))).activity, 'searching')
  assert.deepEqual(adapter.handle(tool('read-one', 'running')), [])
  assert.equal(lastState(adapter.handle(tool('read-one', 'completed'))).state, 'THINKING')
  assert.deepEqual(adapter.handle(bus('message.part.updated', {
    part: { type: 'step-finish', sessionID: 'one', reason: 'tool-calls' },
  })), [])
  const messages = adapter.handle(bus('todo.updated', { sessionID: 'one', todos: [
    { content: '完成接入', status: 'completed' }, { content: '验证插件', status: 'in_progress' },
  ] }))
  assert.deepEqual(messages.find((message) => message.kind === 'task').progress, { completed: 1, total: 2, current: 2 })
  assert.equal(messages[0].project, 'project')
  assert.equal(adapter.handle(status('idle')).filter((message) => message.state === 'SUCCESS').length, 1)
  assert.deepEqual(adapter.handle(bus('session.idle', { sessionID: 'one' })), [])
})

test('parallel tools do not dismiss permissions or repeat approval alerts', () => {
  const adapter = new OpenCodeEvents({ directory: '/work/project' })
  adapter.handle(status('busy'))
  adapter.handle(tool('one', 'running', 'bash'))
  const asked = adapter.handle(bus('permission.asked', { id: 'p1', sessionID: 'one', permission: 'bash' }))
  assert.equal(lastState(asked).state, 'WAITING')
  assert.equal(asked.filter((message) => message.kind === 'alert').length, 1)
  assert.deepEqual(adapter.handle(bus('permission.asked', { id: 'p1', sessionID: 'one', permission: 'bash' })), [])
  assert.deepEqual(adapter.handle(tool('two', 'running')), [])
  assert.deepEqual(adapter.handle(tool('two', 'completed')), [])
  adapter.handle(bus('permission.asked', { id: 'p2', sessionID: 'one', permission: 'edit' }))
  assert.equal(lastState(adapter.handle(bus('permission.replied', { requestID: 'p1', sessionID: 'one' }))).state, 'WAITING')
  assert.equal(lastState(adapter.handle(bus('permission.replied', { requestID: 'p2', sessionID: 'one' }))).state, 'WORKING')
})

test('question replies resume work and error followed by idle never signals success', () => {
  const adapter = new OpenCodeEvents()
  adapter.handle(status('busy'))
  adapter.handle(tool('question-one', 'running', 'question'))
  assert.equal(lastState(adapter.handle(bus('question.asked', {
    id: 'q1', sessionID: 'one', tool: { callID: 'question-one' },
  }))).state, 'WAITING')
  assert.equal(lastState(adapter.handle(bus('question.replied', { requestID: 'q1', sessionID: 'one' }))).state, 'THINKING')
  adapter.handle(tool('question-one', 'completed', 'question'))
  const failed = adapter.handle(bus('session.error', { sessionID: 'one', error: { name: 'APIError' } }))
  assert.equal(lastState(failed).state, 'ERROR')
  assert.deepEqual(adapter.handle(status('idle')), [])
  adapter.handle(status('busy'))
  const cancelled = adapter.handle(bus('session.error', { sessionID: 'one', error: { name: 'MessageAbortedError' } }))
  assert.equal(lastState(cancelled).state, 'IDLE')
  assert.equal(lastState(cancelled).stage, '已停止')
  assert.deepEqual(adapter.handle(status('idle')), [])
})

test('tool errors pulse once and completed historical messages cannot create a turn', () => {
  const adapter = new OpenCodeEvents()
  assert.deepEqual(adapter.handle(bus('message.updated', {
    info: { role: 'assistant', sessionID: 'one', time: { completed: 123 } },
  })), [])
  assert.deepEqual(adapter.handle(status('idle')), [])
  adapter.handle(status('busy'))
  adapter.handle(tool('failed', 'running', 'bash'))
  assert.equal(adapter.handle(tool('failed', 'error', 'bash')).find((message) => message.kind === 'pulse').state, 'ERROR')
  assert.deepEqual(adapter.handle(tool('failed', 'error', 'bash')), [])
})

test('child sessions are excluded by default, supported when enabled, and deleted cleanly', () => {
  const adapter = new OpenCodeEvents()
  adapter.setSession({ id: 'child', directory: '/work/child', parentID: 'one' })
  assert.deepEqual(adapter.handle(status('busy', 'child')), [])
  const all = new OpenCodeEvents({ includeSubagents: true })
  all.setSession({ id: 'child', directory: '/work/child', parentID: 'one' })
  all.handle(status('busy', 'child'))
  const idle = lastState(all.handle(bus('session.deleted', { info: { id: 'child' } })))
  assert.equal(idle.state, 'IDLE')
  assert.equal(idle.message, 'OpenCode 空闲中')
  assert.equal(all.sessions.has('child'), false)
})

test('multiple sessions preserve active work when another session completes', () => {
  const adapter = new OpenCodeEvents()
  adapter.handle(status('busy', 'one'))
  adapter.handle(tool('work', 'running', 'edit', 'one'))
  const messages = adapter.handle(status('busy', 'two'))
  assert.equal(messages.find((message) => message.kind === 'tasks').tasks.length, 2)
  const done = adapter.handle(status('idle', 'two'))
  assert.equal(done.find((message) => message.kind === 'pulse').resumeState, 'WORKING')
})

test('adapter and reducer session storage remain bounded', () => {
  const adapter = new OpenCodeEvents({ maxSessions: 3 })
  for (let index = 0; index < 10; index += 1) adapter.handle(status('busy', String(index)))
  assert.equal(adapter.sessions.size, 3)
  assert.equal(adapter.reducer.sessions.size, 3)
})
