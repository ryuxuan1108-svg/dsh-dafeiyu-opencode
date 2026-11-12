import assert from 'node:assert/strict'
import test from 'node:test'
import { petChat, petModelContext } from '../src/opencode-pet-actions.js'

test('pet model context exposes model names without credentials', () => {
  const context = petModelContext({ small_model: 'relay/small', provider: { relay: {
    name: 'Relay', options: { apiKey: 'never-export-me' }, models: { small: { name: 'Small model' } },
  } } })
  assert.deepEqual(context.selection, { provider: 'relay', model: 'small' })
  assert.equal(JSON.stringify(context).includes('never-export-me'), false)
  assert.deepEqual(petModelContext({}, 'relay/vision/model').selection, { provider: 'relay', model: 'vision/model' })
})

test('pet chat denies project tools, forwards images and removes its temporary session', async () => {
  const ignored = new Set()
  let deleted = false
  const result = await petChat({ directory: '/work/project', context: { selection: { provider: 'relay', model: 'chat' } },
    ignoredSessions: ignored, request: { system: '你是大肥鱼。', messages: [{ role: 'user', content: [
      { type: 'text', text: '看看这张图片' }, { type: 'image', mediaType: 'image/png', data: 'base64-image' },
    ] }] },
    client: { session: {
      async create(input) {
        assert.deepEqual(input.body.permission, [{ permission: '*', pattern: '*', action: 'deny' }])
        return { data: { id: 'pet-only' } }
      },
      async prompt(input) {
        assert.equal(ignored.has('pet-only'), true)
        assert.deepEqual(input.body.model, { providerID: 'relay', modelID: 'chat' })
        assert.match(input.body.system, /不调用工具/)
        assert.equal(input.body.parts[1].url, 'data:image/png;base64,base64-image')
        return { data: { parts: [{ type: 'text', text: '你好主人！' }] } }
      },
      async delete(input) { assert.equal(input.path.id, 'pet-only'); deleted = true },
    } },
  })
  assert.deepEqual(result, { text: '你好主人！' })
  assert.equal(deleted, true)
})

test('chat failures clean up and never return raw provider errors', async () => {
  let deleted = false
  await assert.rejects(petChat({ directory: '/work/project', context: { selection: { provider: 'relay', model: 'chat' } },
    request: { messages: [] }, ignoredSessions: new Set(), client: { session: {
      async create() { return { data: { id: 'failed-pet' } } },
      async prompt() { throw new Error('upstream echoed an-api-key') },
      async delete() { deleted = true },
    } },
  }), (error) => !error.message.includes('an-api-key') && error.message.includes('模型调用'))
  assert.equal(deleted, true)
})
