import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPetEngine, upstreamBalance } from '../dist/dsh-pet-engine.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }
test('upstream balance animations use reported quota percentages without guessing wallet totals', () => {
  assert.equal(upstreamBalance({ summary: '余额', available: true }).data.percent, undefined)
  assert.equal(upstreamBalance({ summary: '套餐剩余额度', available: true, usedPercent: 80 }).data.percent, 80)
})
test('upstream engine supplies animations, single pet, sleep, reminders, chat memory and OpenCode balance', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-upstream-pet-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const calls = []
  const engine = await createPetEngine({ home, settings: {}, logger, headless: true,
    context: { selection: { provider: 'test', model: 'test-model' }, providers: [{ id: 'test', name: 'Test', models: [{ id: 'test-model', name: 'Test model' }] }] },
    async request(action, input) {
      calls.push({ action, input })
      if (action === 'chat') return { text: '主人，任务完成啦。' }
      return { status: 'ready', available: true, summary: 'Sub2API 账户余额 US$12.50' }
    },
  })
  t.after(() => engine.stop())
  const config = await engine.call('/config')
  assert.equal(Object.values(config).flatMap((entry) => entry.pets || []).length, 1)
  assert.equal(config.main.pets[0].display, 'desktop')
  assert.ok(config.main.animations.categories.length > 0)
  assert.ok(config.main.animations.sleep.length > 0)
  assert.ok(config.main.physics.gravity > 0)
  const saved = JSON.parse(await readFile(join(home, 'dsh-pet/main-config.jsonc'), 'utf8'))
  saved.pets.push({ ...saved.pets[0], id: 'second-pet' })
  await writeFile(join(home, 'dsh-pet/main-config.jsonc'), JSON.stringify(saved))
  assert.equal(Object.values(await engine.call('/config')).flatMap((entry) => entry.pets || []).length, 1)
  await engine.send({ kind: 'state', state: 'WORKING', detail: 'OpenCode · 测试上游引擎' })
  assert.equal((await engine.call('/state')).sections.workStatus.data.state, 'working')
  await engine.call('/sleep?pet=main', 'POST', {})
  assert.equal((await engine.call('/state')).pets.main.sleep.data.sleeping, true)
  await engine.call('/wake?pet=main', 'POST', {})
  assert.equal((await engine.call('/state')).pets.main.sleep.data.sleeping, false)
  await engine.call('/todos', 'POST', { text: '验证提醒功能', dueAt: Date.now() + 3600000 })
  const todos = await engine.call('/todos')
  assert.ok(JSON.stringify(todos).includes('验证提醒功能'))
  const chat = await engine.call('/chat?pet=main&surface=desktop', 'POST', { text: '你好大肥鱼' })
  assert.equal(chat.ok, true, JSON.stringify(chat))
  assert.equal(chat.text, '主人，任务完成啦。')
  assert.ok(calls.some((call) => call.action === 'chat'))
  const history = await engine.call('/chat?pet=main')
  assert.ok(JSON.stringify(history).includes('你好大肥鱼'))
  const picture = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII='
  const pictured = await engine.call('/chat?pet=main&surface=desktop', 'POST', { text: '看这张图片', attachment: { mediaType: 'image/png', data: picture } })
  assert.equal(pictured.ok, true, JSON.stringify(pictured))
  assert.ok(calls.findLast((call) => call.action === 'chat').input.messages.at(-1).content.some((part) => part.type === 'image' && part.data === picture))
  await engine.send({ kind: 'pulse', state: 'SUCCESS', detail: '已完成', ttlMs: 200 })
  assert.equal((await engine.call('/state')).sections.notify.data.event.type, 'turn/end')
  await engine.call('/balance', 'POST', {})
  assert.ok(JSON.stringify((await engine.call('/state')).sections.balance.data).includes('Sub2API'))
  const runtime = JSON.parse(await readFile(join(home, 'dsh-pet/opencode-runtime.json'), 'utf8'))
  assert.equal(runtime.port, engine.port)
  const page = await fetch(`http://127.0.0.1:${engine.port}/standalone-ai/`)
  assert.ok((await page.text()).includes('OpenCode 大肥鱼'))
  const panel = await fetch(`http://127.0.0.1:${engine.port}/standalone-ai/chat-panel.js`)
  assert.equal(panel.status, 200)
})
