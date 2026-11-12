import { balanceAmount, balanceError, fetchBalanceJson, parseApiBalance } from './balance.js'

function amount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw balanceError('INVALID_RESPONSE')
    value = String(value)
  }
  return balanceAmount(value)
}

function currency(value) {
  if (!['USD', 'CNY'].includes(value)) throw balanceError('INVALID_RESPONSE')
  return value
}

function nonnegative(value) {
  const parsed = amount(value)
  if (Number(parsed) < 0) throw balanceError('INVALID_RESPONSE')
  return parsed
}

function minimumAmount(values) {
  const decimals = Math.max(...values.map((value) => value.split('.')[1]?.length ?? 0))
  const integer = (value) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole + fraction.padEnd(decimals, '0'))
  }
  return values.reduce((left, right) => integer(left) <= integer(right) ? left : right)
}

// Only return balance fields; /v1/usage also includes histories and plan names
// which are irrelevant to the pet and may contain private upstream metadata.
export function parseSub2ApiUsage(body) {
  if (!['unrestricted', 'quota_limited'].includes(body?.mode) || typeof body.isValid !== 'boolean') {
    throw balanceError('INVALID_RESPONSE')
  }
  const active = body.isValid && (!body.status || body.status === 'active')
  let balanceKind
  let total
  const percentages = []
  const recordUsage = (limit, used) => {
    if (limit == null || used == null) return
    const cap = Number(amount(limit))
    const consumed = Number(nonnegative(used))
    if (cap > 0) percentages.push(Math.min(100, Math.max(0, consumed / cap * 100)))
  }
  let unit = body.unit === undefined ? undefined : currency(body.unit)
  if (body.mode === 'quota_limited') {
    balanceKind = 'key-quota'
    const remaining = []
    if (body.quota) {
      unit = currency(body.quota.unit ?? body.unit)
      remaining.push(nonnegative(body.quota.remaining))
      recordUsage(body.quota.limit, body.quota.used)
    } else if (body.remaining !== undefined) {
      unit = currency(body.unit)
      remaining.push(nonnegative(body.remaining))
    }
    if (body.rate_limits !== undefined) {
      if (!Array.isArray(body.rate_limits) || body.rate_limits.length > 8) throw balanceError('INVALID_RESPONSE')
      for (const window of body.rate_limits) {
        if (!['5h', '1d', '7d'].includes(window?.window)) throw balanceError('INVALID_RESPONSE')
        remaining.push(nonnegative(window.remaining))
        recordUsage(window.limit, window.used)
      }
      // Sub2API rate-limit windows are denominated in USD.
      if (body.rate_limits.length && unit && unit !== 'USD') throw balanceError('INVALID_RESPONSE')
      if (body.rate_limits.length) unit = 'USD'
    }
    if (!remaining.length) throw balanceError('INVALID_RESPONSE')
    total = minimumAmount(remaining)
  } else if (body.balance !== undefined) {
    balanceKind = 'wallet'
    unit = currency(body.unit)
    total = amount(body.balance)
  } else if (body.subscription && typeof body.subscription === 'object' && !Array.isArray(body.subscription)) {
    balanceKind = 'subscription'
    unit = currency(body.unit)
    total = amount(body.remaining)
    if (Number(total) === -1) {
      return { source: 'sub2api', balanceKind, unlimited: true, available: active, balances: [] }
    }
    if (Number(total) < 0) throw balanceError('INVALID_RESPONSE')
    for (const window of ['daily', 'weekly', 'monthly']) {
      recordUsage(body.subscription[`${window}_limit_usd`], body.subscription[`${window}_usage_usd`])
    }
  } else {
    throw balanceError('INVALID_RESPONSE')
  }
  return {
    source: 'sub2api', balanceKind, available: active && Number(total) > 0,
    balances: [{ currency: unit, total }],
    ...(percentages.length ? { usedPercent: Math.max(...percentages) } : {}),
  }
}

function isSub2Api(id, info = {}) {
  return /sub(?:2api|api2)/i.test(`${id} ${info.name ?? ''}`)
}

function modelProvider(config) {
  return typeof config.model === 'string' ? config.model.split('/')[0] : config.model?.providerID
}

function selectProvider(settings, providers, current) {
  if (settings.balanceProvider) return settings.balanceProvider
  if (settings.balanceType === 'deepseek') return 'deepseek'
  if (current && isSub2Api(current, providers[current])) return current
  const sub = Object.keys(providers).find((id) => isSub2Api(id, providers[id]))
  return sub || (settings.balanceType === 'sub2api' ? current || 'sub2api' : 'deepseek')
}

export function balanceEndpoint(baseURL, type) {
  let url
  try { url = new URL(baseURL) } catch { throw balanceError('NOT_CONFIGURED') }
  let path = url.pathname.replace(/\/+$/, '')
  if (type === 'sub2api') {
    if (!path.endsWith('/v1')) path += '/v1'
    url.pathname = `${path}/usage`
    url.search = '?days=1'
  } else {
    path = path.replace(/\/(?:v1|anthropic)$/, '')
    url.pathname = `${path}/user/balance`
    url.search = ''
  }
  url.hash = ''
  return url
}

// The selected provider owns both its URL and key. A missing Sub2API key must
// never fall back to DeepSeek credentials (or vice versa).
export function createOpenCodeBalanceQuery({ client, directory, getConfig, getSettings, environment = process.env, fetchImpl }) {
  return async (_, signal) => {
    const config = getConfig()
    const settings = getSettings()
    const providers = config.provider ?? config.providers ?? {}
    const current = modelProvider(config)
    const requestedType = settings.balanceType ?? 'auto'
    let id = selectProvider(settings, providers, current)
    let provider = providers[id] ?? {}
    let type = requestedType === 'auto' ? (isSub2Api(id, provider) ? 'sub2api' : 'deepseek') : requestedType
    let options = provider.options ?? {}
    const environmentKey = () => type === 'sub2api'
      ? environment.SUB2API_API_KEY || environment.SUBAPI2_API_KEY : environment.DEEPSEEK_API_KEY
    const environmentBaseURL = () => type === 'sub2api'
      ? environment.SUB2API_BASE_URL || environment.SUBAPI2_BASE_URL : environment.DEEPSEEK_BASE_URL
    let key = options.apiKey || environmentKey()
    if ((!key || (type === 'sub2api' && !options.baseURL && !provider.api && !environmentBaseURL())) && client?.config?.providers) {
      const result = await client.config.providers({ query: { directory }, signal })
      const available = result.data?.providers ?? []
      if (requestedType !== 'deepseek' && !settings.balanceProvider && !providers[id] && !isSub2Api(id)) {
        const sub = available.find((item) => isSub2Api(item.id, item))
        if (sub) { id = sub.id; type = 'sub2api' }
      } else if (requestedType !== 'deepseek' && !settings.balanceProvider && id === 'sub2api' && !providers[id]) {
        const sub = available.find((item) => isSub2Api(item.id, item))
        if (sub) id = sub.id
      }
      const resolved = available.find((item) => item.id === id)
      provider = providers[id] ?? resolved ?? {}
      options = { ...resolved?.options, ...provider.options }
      key = options.apiKey || environmentKey() || resolved?.key
    }
    const baseURL = options.baseURL || provider.api || environmentBaseURL() || (type === 'deepseek' ? 'https://api.deepseek.com' : undefined)
    if (typeof key !== 'string' || !key.trim() || !baseURL) throw balanceError('NOT_CONFIGURED')
    const body = await fetchBalanceJson(balanceEndpoint(baseURL, type), {
      apiKey: key, signal, fetchImpl, maxBytes: type === 'sub2api' ? 131072 : 32768,
      // An explicitly selected OpenCode provider may already use an HTTP
      // relay. Honor that provider's configured URL without changing discovery.
      allowHttp: type === 'sub2api' && settings.balanceProvider === id && Boolean(providers[id]),
    })
    return type === 'sub2api' ? parseSub2ApiUsage(body) : { ...parseApiBalance(body), source: 'api-key' }
  }
}
