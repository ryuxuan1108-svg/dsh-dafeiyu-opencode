// Chat runs through OpenCode's own SDK so its provider authentication and
// protocol adapters stay authoritative. The temporary chat has no tool access.
export function petModelContext(config, current) {
  const model = current || config.small_model || config.model
  const selection = typeof model === 'string'
    ? { provider: model.slice(0, model.indexOf('/')), model: model.slice(model.indexOf('/') + 1) }
    : { provider: model?.providerID || '', model: model?.modelID || model?.model || '' }
  return { selection, providers: Object.entries(config.provider || config.providers || {}).map(([id, provider]) => ({
    id, name: provider.name || id,
    models: Object.entries(provider.models || {}).map(([id, model]) => ({ id, name: model.name || id })),
  })) }
}

export async function petChat({ client, directory, context, request, ignoredSessions, signal }) {
  const selection = request.provider && request.model ? { provider: request.provider, model: request.model } : context.selection
  if (!selection?.provider || !selection.model) throw new Error('请在 OpenCode 中选择聊天模型。')
  const created = await client.session.create({ query: { directory }, signal: AbortSignal.timeout(5000), body: {
    title: '大肥鱼 · 闲聊', permission: [{ permission: '*', pattern: '*', action: 'deny' }],
  } })
  const id = created.data?.id
  if (!id) throw new Error('无法创建桌宠对话，请检查 OpenCode 连接。')
  ignoredSessions.add(id)
  try {
    // Prior turns remain in upstream's memory.json. Every request uses a fresh
    // text-only session so the coding agent cannot execute tools on its behalf.
    const history = (request.messages || []).map((message) => ({
      role: message.role,
      text: Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : String(message.content || ''),
    }))
    const images = (request.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === 'image' && typeof part.data === 'string')
    const result = await client.session.prompt({ path: { id }, query: { directory }, body: {
      model: { providerID: selection.provider, modelID: selection.model },
      system: `${request.system || ''}\n只输出聊天回复，不调用工具、不操作项目文件。`,
      parts: [{ type: 'text', text: history.map((message) => `${message.role === 'assistant' ? '大肥鱼' : '用户'}：${message.text}`).join('\n\n') },
        ...images.map((image) => ({ type: 'file', mime: image.mediaType, url: `data:${image.mediaType};base64,${image.data}` }))],
    }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) })
    const text = result.data?.parts?.filter((part) => part.type === 'text').map((part) => part.text).join('').trim()
    if (!text) throw new Error('模型未返回文字，请检查所选模型。')
    return { text }
  } catch {
    throw new Error('桌宠模型调用未完成，请检查 OpenCode 中的服务商、模型和连接。')
  } finally {
    if (signal?.aborted) {
      try { await client.session.abort?.({ path: { id }, query: { directory }, signal: AbortSignal.timeout(5000) }) } catch {}
    }
    try { await client.session.delete({ path: { id }, query: { directory }, signal: AbortSignal.timeout(5000) }) } catch {}
    // Delete events can still be in the bus queue after the request resolves.
    const timer = setTimeout(() => ignoredSessions.delete(id), 5000)
    timer.unref?.()
  }
}
