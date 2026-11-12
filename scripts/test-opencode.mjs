import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Run a real OpenCode server and a local, deterministic model. No account or
// external model request is needed. All OpenCode data/config stays in a temp dir.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineName = process.env.OPENCODE_DAFEIYU_TEST_ENGINE === 'dsh-pet' ? 'dsh-pet' : 'native'
const directory = await mkdtemp(join(tmpdir(), 'opencode-bigfish-smoke-'))
const secondDirectory = join(directory, 'second-workspace')
await mkdir(secondDirectory)
const output = join(root, '.build')
await mkdir(output, { recursive: true })
const eventLog = join(output, 'opencode-smoke.jsonl')
await rm(eventLog, { force: true })
let fixture = join(directory, 'fixture.txt')
await writeFile(fixture, 'BigFish OpenCode integration fixture\n')
await writeFile(join(secondDirectory, 'fixture.txt'), 'BigFish second workspace fixture\n')
let requests = 0
let balanceRequests = 0
const model = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url?.startsWith('/v1/usage')) {
      assert.equal(req.headers.authorization, 'Bearer local-test')
      balanceRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ mode: 'unrestricted', isValid: true, balance: 12.5, remaining: 12.5, unit: 'USD' }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const petChat = body.messages?.some((message) => message.role === 'system' && String(message.content).includes('只输出聊天回复'))
    requests += 1
    const callTools = !petChat && body.tools?.some((tool) => tool.function?.name === 'read')
      && !body.messages?.some((message) => message.role === 'tool')
    const toolCalls = [
      { id: 'read-fixture', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: fixture }) } },
      { id: 'write-todos', type: 'function', function: { name: 'todowrite', arguments: JSON.stringify({
        todos: [{ content: 'Verify OpenCode integration', status: 'completed', priority: 'high' }],
      }) } },
    ]
    const message = callTools ? { role: 'assistant', content: null, tool_calls: toolCalls }
      : { role: 'assistant', content: petChat ? '主人，任务完成啦。' : 'BigFish smoke test completed.' }
    const result = {
      id: `smoke-${requests}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: 'smoke', choices: [{ index: 0, message, finish_reason: callTools ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
      ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`
    res.write(chunk({ role: 'assistant', ...(callTools
      ? { tool_calls: toolCalls.map((tool, index) => ({ index, ...tool })) }
      : { content: message.content }) }))
    res.write(chunk({}, callTools ? 'tool_calls' : 'stop'))
    res.end('data: [DONE]\n\n')
  } catch {
    res.writeHead(500)
    res.end('smoke model failed')
  }
})
model.listen(0, '127.0.0.1')
await once(model, 'listening')
const provider = `http://127.0.0.1:${model.address().port}/v1`
const configDirectory = join(directory, 'xdg-config', 'opencode')
await mkdir(configDirectory, { recursive: true })
const pluginEntry = pathToFileURL(join(root, 'src', 'opencode.js')).href
// Plugin registration lives only in the isolated global configuration. The
// second workspace also registers it locally to exercise host deduplication.
await writeFile(join(configDirectory, 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json', plugin: [pluginEntry],
}))
await writeFile(join(secondDirectory, 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json', plugin: [pluginEntry],
}))
await writeFile(join(configDirectory, 'dafeiyu.json'), JSON.stringify({
  balanceEnabled: true, balanceType: 'subapi2', balanceProvider: 'bigfish-smoke', soundEnabled: false, petEngine: engineName,
}))
const config = {
  $schema: 'https://opencode.ai/config.json',
  model: 'bigfish-smoke/smoke', small_model: 'bigfish-smoke/smoke',
  enabled_providers: ['bigfish-smoke'], snapshot: false,
  provider: { 'bigfish-smoke': {
    npm: '@ai-sdk/openai-compatible', options: { apiKey: 'local-test', baseURL: provider },
    models: { smoke: { name: 'Smoke', limit: { context: 32000, output: 2000 } } },
  } },
}
const environment = {
  ...process.env,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_CONFIG_DIR: '',
  OPENCODE_CONFIG: '', OPENCODE_DAFEIYU_CONFIG: '',
  OPENCODE_TEST_HOME: directory,
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_SERVER_PASSWORD: '',
  XDG_CONFIG_HOME: join(directory, 'xdg-config'), XDG_DATA_HOME: join(directory, 'data'),
  XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
  DSH_DAFEIYU_HEADLESS: '1', DSH_DAFEIYU_EVENT_LOG: eventLog,
  OPENCODE_DAFEIYU_PET_HEADLESS: '1',
  DSH_DAFEIYU_LOG_FILE: join(output, 'opencode-helper.log'),
  DSH_DAFEIYU_USER_SETTINGS: join(directory, 'dsh-settings.json'),
}
const args = ['serve', '--port', '0', '--hostname', '127.0.0.1']
// npm installs a Node launcher rather than an executable on Windows. An
// explicit OPENCODE_BIN also supports standalone and package-manager installs.
const command = process.env.OPENCODE_BIN || (process.platform === 'win32' ? process.execPath : 'opencode')
const launchArgs = !process.env.OPENCODE_BIN && process.platform === 'win32'
  ? [join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode'), ...args] : args
const child = spawn(command, launchArgs, { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
child.stdout.on('data', (chunk) => { log += chunk.toString() })
child.stderr.on('data', (chunk) => { log += chunk.toString() })
child.on('error', (error) => { log += error.message })
const deadline = Date.now() + 45000
async function waitFor(predicate, label) {
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    if (child.exitCode !== null) throw new Error(`OpenCode exited before ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function messages() {
  try { return (await readFile(eventLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }
  catch { return [] }
}
let baseURL
try {
  baseURL = await waitFor(() => /listening on (http:\/\/[^\s]+)/.exec(log)?.[1], 'server startup')
  const request = async (path, method, body, workspace = directory) => {
    const url = new URL(path, baseURL)
    url.searchParams.set('directory', workspace)
    const response = await fetch(url, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: HTTP ${response.status}: ${text.slice(0, 500)}`)
    return text ? JSON.parse(text) : undefined
  }
  const sessions = []
  for (const workspace of [directory, secondDirectory]) {
    fixture = join(workspace, 'fixture.txt')
    const session = await request('/session', 'POST', { title: 'BigFish integration smoke' }, workspace)
    sessions.push(session)
    await request(`/session/${session.id}/message`, 'POST', {
      model: { providerID: 'bigfish-smoke', modelID: 'smoke' },
      parts: [{ type: 'text', text: 'Read fixture.txt and mark the integration todo complete.' }],
    }, workspace)
    await waitFor(async () => (await messages()).some((message) => message.state === 'SUCCESS' && message.sessionId.endsWith(`/${session.id}`)),
      'workspace completion')
  }
  const received = await waitFor(async () => {
    const values = await messages()
    return values.filter((message) => message.state === 'SUCCESS').length === 2
      && values.filter((message) => message.kind === 'balance' && message.status === 'ready').length === 2 && values
  }, 'native helper completion')
  assert.equal(received.filter((message) => message.kind === 'hello' && message.host === 'opencode').length, 1,
    'all workspaces must share one native Helper, including duplicate global/project registration')
  assert.ok(received.some((message) => message.kind === 'config' && !message.openUrl.includes(':0/')))
  assert.ok(received.some((message) => message.state === 'THINKING'))
  assert.ok(received.some((message) => message.state === 'WORKING' && message.activity === 'searching'))
  assert.ok(received.some((message) => message.kind === 'task' && message.progress?.completed === 1))
  assert.equal(received.filter((message) => message.state === 'SUCCESS').length, 2)
  for (const session of sessions) {
    assert.ok(received.some((message) => message.sessionId?.endsWith(`/${session.id}`) && message.state === 'THINKING'))
    assert.ok(received.some((message) => message.sessionId?.endsWith(`/${session.id}`) && message.kind === 'task' && message.progress?.completed === 1))
  }
  const balance = received.find((message) => message.kind === 'balance' && message.status === 'ready')
  assert.equal(balance.source, 'sub2api')
  assert.equal(balance.balances[0].total, '12.5')
  assert.match(balance.summary, /Sub2API 账户余额/)
  assert.equal(JSON.stringify(received).includes('local-test'), false)
  assert.equal(balanceRequests, 2)
  if (engineName === 'dsh-pet') {
    const runtime = JSON.parse(await readFile(join(configDirectory, 'pet-runtime', 'dsh-pet', 'opencode-runtime.json'), 'utf8'))
    const petRequest = async (path, method = 'GET', body) => {
      const token = new URL(runtime.settingsUrl).hash.slice('#token='.length)
      const response = await fetch(`http://127.0.0.1:${runtime.port}/dsh-pet-7340${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-dsh-pet-token': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
      })
      assert.equal(response.status, 200)
      return response.json()
    }
    const upstreamConfig = await petRequest('/config')
    assert.equal(Object.values(upstreamConfig).flatMap((entry) => entry.pets || []).length, 1)
    await petRequest('/sleep?pet=main', 'POST', {})
    assert.equal((await petRequest('/state')).pets.main.sleep.data.sleeping, true)
    await petRequest('/wake?pet=main', 'POST', {})
    await petRequest('/todos', 'POST', { text: '验证 OpenCode 待办', dueAt: Date.now() + 3600000 })
    assert.ok(JSON.stringify(await petRequest('/todos')).includes('验证 OpenCode 待办'))
    const chat = await petRequest('/chat?pet=main&surface=desktop', 'POST', { text: '你好大肥鱼' })
    assert.equal(chat.ok, true, JSON.stringify(chat))
    assert.equal(chat.text, '主人，任务完成啦。')
    assert.ok(JSON.stringify(await petRequest('/chat?pet=main')).includes('你好大肥鱼'))
    assert.equal((await messages()).filter((message) => message.state === 'SUCCESS').length, 2,
      'pet chat must not be counted as a coding turn')
  }
  await request('/instance/dispose', 'POST')
  assert.equal((await messages()).filter((message) => message.kind === 'shutdown').length, 0,
    'closing the first workspace must keep the shared Helper alive')
  fixture = join(secondDirectory, 'fixture.txt')
  await request(`/session/${sessions[1].id}/message`, 'POST', {
    model: { providerID: 'bigfish-smoke', modelID: 'smoke' },
    parts: [{ type: 'text', text: 'Confirm the shared companion is still connected.' }],
  }, secondDirectory)
  await waitFor(async () => (await messages()).filter((message) => message.state === 'SUCCESS').length === 3,
    'remaining workspace after original workspace disposal')
  await request('/instance/dispose', 'POST', undefined, secondDirectory)
  await waitFor(async () => (await messages()).filter((message) => message.kind === 'shutdown').length === 1, 'shared helper shutdown')
  assert.equal((await messages()).filter((message) => message.kind === 'hello').length, 1)
  console.log(`OpenCode integration passed (${engineName}, 2 workspaces, 1 shared Helper, ${requests} local model requests, ${balanceRequests} Sub2API balance requests): ${eventLog}`)
} catch (error) {
  await writeFile(join(output, 'opencode-smoke-host.log'), log)
  throw error
} finally {
  if (child.exitCode === null) child.kill()
  model.closeAllConnections()
  model.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}
