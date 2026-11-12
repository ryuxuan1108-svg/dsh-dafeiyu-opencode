import assert from 'node:assert/strict'
import test from 'node:test'
import { balanceSummary, createBalanceMonitor } from '../src/balance.js'
import { balanceEndpoint, createOpenCodeBalanceQuery, parseSub2ApiUsage } from '../src/opencode-balance.js'
import { normalizeSettings } from '../src/opencode-settings.js'

const wallet = { mode: 'unrestricted', isValid: true, balance: 12.5, remaining: 12.5, unit: 'USD' }
const subscription = { mode: 'unrestricted', isValid: true, remaining: 8.25, unit: 'USD', subscription: {
  daily_limit_usd: 10, daily_usage_usd: 1.75,
} }
const snapshot = (result, status = 'ready') => ({ ...result, status })
const query = ({ config = {}, settings = {}, environment = {}, client, fetchImpl } = {}) => createOpenCodeBalanceQuery({
  directory: '/work/project', getConfig: () => config,
  getSettings: () => normalizeSettings(settings), environment, client, fetchImpl,
})

test('Sub2API wallet balance accepts numeric and decimal values without inventing recharge amounts', () => {
  const result = parseSub2ApiUsage({ ...wallet, balance: '12.34567890123456789', planName: 'private', usage: { secret: 'omit-me' } })
  assert.deepEqual(result, {
    source: 'sub2api', balanceKind: 'wallet', available: true,
    balances: [{ currency: 'USD', total: '12.34567890123456789' }],
  })
  assert.match(balanceSummary(snapshot(result)), /Sub2API 账户余额/)
  assert.equal(parseSub2ApiUsage({ ...wallet, balance: 0 }).available, false)
  assert.equal(parseSub2ApiUsage({ ...wallet, balance: -1 }).unlimited, undefined)
})

test('Sub2API quota displays the smallest remaining key or time-window allowance precisely', () => {
  const result = parseSub2ApiUsage({
    mode: 'quota_limited', isValid: true, status: 'active', unit: 'USD', remaining: 10,
    quota: { limit: 20, used: 10, remaining: 10, unit: 'USD' },
    rate_limits: [{ window: '5h', remaining: '1.000000000000000001' }, { window: '1d', remaining: '1.000000000000000000' }],
  })
  assert.equal(result.balanceKind, 'key-quota')
  assert.equal(result.usedPercent, 50)
  assert.equal(result.balances[0].total, '1.000000000000000000')
  assert.match(balanceSummary(snapshot(result)), /Key 可用额度/)
  const windows = parseSub2ApiUsage({ mode: 'quota_limited', isValid: true,
    rate_limits: [{ window: '7d', remaining: 5 }, { window: '5h', remaining: 2 }],
  })
  assert.deepEqual(windows.balances, [{ currency: 'USD', total: '2' }])
  assert.equal(parseSub2ApiUsage({ mode: 'quota_limited', isValid: true, remaining: 0, unit: 'USD' }).available, false)
})

test('Sub2API subscriptions distinguish limited, unlimited and expired plans', () => {
  assert.equal(parseSub2ApiUsage(subscription).usedPercent, 17.5)
  assert.match(balanceSummary(snapshot(parseSub2ApiUsage(subscription))), /套餐剩余额度/)
  const unlimited = parseSub2ApiUsage({ ...subscription, remaining: -1 })
  assert.deepEqual(unlimited.balances, [])
  assert.equal(unlimited.unlimited, true)
  assert.equal(balanceSummary(snapshot(unlimited)), 'Sub2API 套餐不限额')
  assert.match(balanceSummary(snapshot(unlimited, 'error')), /上次查询/)
  const expired = parseSub2ApiUsage({ ...subscription, remaining: -1, status: 'expired' })
  assert.equal(expired.available, false)
  assert.match(balanceSummary(snapshot(expired)), /不可用/)
})

test('Sub2API missing values and invalid payloads never turn into zero or unlimited balances', () => {
  for (const body of [
    null, {}, { ...wallet, mode: 'unknown' }, { ...wallet, isValid: 'true' },
    { ...wallet, balance: null }, { ...wallet, balance: '' }, { ...wallet, balance: Infinity },
    { ...wallet, balance: '1e99999' }, { ...wallet, balance: true }, { ...wallet, unit: 'EUR' },
    { ...subscription, remaining: undefined }, { ...subscription, remaining: -2 },
    { mode: 'unrestricted', isValid: true, unit: 'USD', remaining: -1 },
    { mode: 'quota_limited', isValid: true },
    { mode: 'quota_limited', isValid: true, remaining: -1, unit: 'USD' },
    { mode: 'quota_limited', isValid: true, rate_limits: [{ window: '5h' }] },
    { mode: 'quota_limited', isValid: true, rate_limits: [{ window: 'forever', remaining: 1 }] },
    { mode: 'quota_limited', isValid: true, rate_limits: Array(9).fill({ window: '5h', remaining: 1 }) },
  ]) assert.throws(() => parseSub2ApiUsage(body), { code: 'INVALID_RESPONSE' })
})

test('Sub2API endpoints preserve proxy prefixes and avoid duplicate v1 paths', () => {
  for (const [base, expected] of [
    ['https://relay.example', 'https://relay.example/v1/usage?days=1'],
    ['https://relay.example/v1/', 'https://relay.example/v1/usage?days=1'],
    ['https://relay.example/proxy/v1?ignored=true#fragment', 'https://relay.example/proxy/v1/usage?days=1'],
    ['https://relay.example/proxy', 'https://relay.example/proxy/v1/usage?days=1'],
  ]) assert.equal(balanceEndpoint(base, 'sub2api').href, expected)
})

test('Sub2API aliases automatically select OpenCode provider credentials and forward cancellation', async () => {
  for (const id of ['sub2api', 'subapi2']) {
    const controller = new AbortController()
    const run = query({
      config: { model: `${id}/model`, provider: { [id]: { options: { apiKey: 'relay-secret', baseURL: 'https://relay.example/v1' } } } },
      fetchImpl: async (url, options) => {
        assert.equal(url.href, 'https://relay.example/v1/usage?days=1')
        assert.equal(options.headers.Authorization, 'Bearer relay-secret')
        assert.equal(options.signal, controller.signal)
        assert.equal(options.redirect, 'error')
        return new Response(JSON.stringify(wallet))
      },
    })
    const result = await run('api-key', controller.signal)
    assert.equal(result.balanceKind, 'wallet')
    assert.equal(JSON.stringify(result).includes('relay-secret'), false)
  }
})

test('explicit custom provider resolves a saved SDK key and SDK gateway options', async () => {
  const run = query({
    settings: { balanceType: 'subapi2', balanceProvider: 'my-relay' },
    config: { provider: { 'my-relay': { name: 'My gateway' } } },
    client: { config: { async providers() { return { data: { providers: [{
      id: 'my-relay', key: 'sdk-relay-secret', options: { baseURL: 'https://relay.example/v1' },
    }] } } } } },
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/v1/usage')
      assert.equal(options.headers.Authorization, 'Bearer sdk-relay-secret')
      return new Response(JSON.stringify(subscription))
    },
  })
  assert.equal((await run()).balanceKind, 'subscription')
})

test('Sub2API can use the current custom provider, discover an SDK provider, or use environment settings', async () => {
  for (const options of [
    { settings: { balanceType: 'sub2api' }, config: { model: 'custom/model', provider: {
      custom: { options: { apiKey: 'relay-secret', baseURL: 'https://relay.example' } },
    } } },
    { settings: { balanceType: 'sub2api' }, client: { config: { async providers() { return { data: { providers: [{
      id: 'subapi2', key: 'relay-secret', options: { baseURL: 'https://relay.example/v1' },
    }] } } } } } },
    { settings: { balanceType: 'sub2api' }, environment: { SUB2API_API_KEY: 'relay-secret', SUB2API_BASE_URL: 'https://relay.example' } },
    { settings: { balanceType: 'subapi2' }, environment: { SUBAPI2_API_KEY: 'relay-secret', SUBAPI2_BASE_URL: 'https://relay.example' } },
  ]) {
    const result = await query({ ...options, fetchImpl: async (url, init) => {
      assert.equal(url.pathname, '/v1/usage')
      assert.equal(init.headers.Authorization, 'Bearer relay-secret')
      return new Response(JSON.stringify(wallet))
    } })()
    assert.equal(result.source, 'sub2api')
  }
})

test('Sub2API never borrows DeepSeek credentials or sends keys to insecure URLs', async () => {
  const fetchImpl = () => { throw new Error('must not fetch') }
  await assert.rejects(query({ settings: { balanceType: 'sub2api' }, environment: {
    DEEPSEEK_API_KEY: 'deepseek-secret', SUB2API_BASE_URL: 'https://relay.example',
  }, fetchImpl })(), { code: 'NOT_CONFIGURED' })
  await assert.rejects(query({ settings: { balanceType: 'sub2api' }, environment: {
    SUB2API_API_KEY: 'relay-secret',
  }, fetchImpl })(), { code: 'NOT_CONFIGURED' })
  for (const baseURL of ['http://relay.example', 'https://user:password@relay.example', 'file:///some/path']) {
    await assert.rejects(query({ settings: { balanceType: 'sub2api' }, environment: {
      SUB2API_API_KEY: 'relay-secret', SUB2API_BASE_URL: baseURL,
    }, fetchImpl })(), { code: 'UNAVAILABLE' })
  }
})

test('Sub2API bounds response size and maps HTTP authentication failures to safe errors', async () => {
  const environment = { SUB2API_API_KEY: 'relay-secret', SUB2API_BASE_URL: 'https://relay.example' }
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [404, 'UNAVAILABLE'], [429, 'UNAVAILABLE'], [500, 'UNAVAILABLE']]) {
    await assert.rejects(query({ settings: { balanceType: 'sub2api' }, environment,
      fetchImpl: async () => new Response('echoed relay-secret', { status }),
    })(), { code })
  }
  let cancelled = false
  await assert.rejects(query({ settings: { balanceType: 'sub2api' }, environment,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(132000)) },
      cancel() { cancelled = true },
    })),
  })(), { code: 'INVALID_RESPONSE' })
  assert.equal(cancelled, true)
})

test('an explicitly selected provider can query its configured LAN HTTP relay', async () => {
  const config = { provider: { openai: { options: { apiKey: 'lan-relay-secret', baseURL: 'http://192.168.1.97:18080/v1' } } } }
  const result = await query({ config, settings: { balanceType: 'sub2api', balanceProvider: 'openai' },
    fetchImpl: async (url, options) => {
      assert.equal(url.href, 'http://192.168.1.97:18080/v1/usage?days=1')
      assert.equal(options.headers.Authorization, 'Bearer lan-relay-secret')
      return new Response(JSON.stringify(wallet))
    },
  })()
  assert.equal(result.balanceKind, 'wallet')
  await assert.rejects(query({ config: { ...config, model: 'openai/model' }, settings: { balanceType: 'sub2api' },
    fetchImpl: () => { throw new Error('automatic selection must not send the key over HTTP') },
  })(), { code: 'UNAVAILABLE' })
})

test('authentication failure clears a previously unlimited plan, and errors never echo secrets', async (t) => {
  let now = 0
  let failed = false
  const monitor = createBalanceMonitor({ now: () => now, query: query({
    settings: { balanceType: 'sub2api' }, environment: { SUB2API_API_KEY: 'relay-secret', SUB2API_BASE_URL: 'https://relay.example' },
    fetchImpl: async () => failed ? new Response('relay-secret', { status: 401 })
      : new Response(JSON.stringify({ ...subscription, remaining: -1 })),
  }) })
  t.after(() => monitor.stop())
  monitor.configure(true)
  await new Promise((resolve) => setImmediate(resolve))
  await monitor.refresh()
  assert.match(monitor.get().summary, /不限额/)
  failed = true
  now += 60000
  await monitor.refresh()
  assert.equal(monitor.get().status, 'error')
  assert.equal(monitor.get().summary.includes('不限额'), false)
  assert.equal(JSON.stringify(monitor.get()).includes('relay-secret'), false)
})
