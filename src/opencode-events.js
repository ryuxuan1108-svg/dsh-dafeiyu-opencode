import { CompanionReducer } from './companion-reducer.js'

// Translate OpenCode's public bus into the existing companion state machine.
// A model step can finish with tool calls; only session idle ends the turn.
export class OpenCodeEvents {
  constructor({ directory, includeSubagents = false, maxSessions = 256, onEvent, onDispose } = {}) {
    this.directory = directory
    this.maxSessions = maxSessions
    this.sessions = new Map()
    this.reducer = new CompanionReducer({ includeSubagents, maxSessions, hostName: 'OpenCode' })
    this.sequence = 0
    this.onEvent = onEvent
    this.onDispose = onDispose
  }

  sessionID(event) {
    return event?.properties?.sessionID ?? event?.properties?.part?.sessionID
      ?? event?.properties?.info?.sessionID ?? event?.properties?.info?.id
  }

  observes(event) {
    return /^(session\.(created|updated|deleted|status|idle|error)|message\.(updated|part\.updated)|todo\.updated|permission\.(asked|replied|updated)|question\.(asked|replied|rejected))$/.test(event?.type ?? '')
  }

  setSession(info) {
    if (!info?.id) return
    const record = this.#session(info.id)
    record.session = {
      id: info.id,
      cwd: info.directory ?? this.directory,
      header: { origin: info.parentID ? 'subagent' : 'user' },
    }
  }

  snapshot() {
    return [...this.reducer.sessions.values()].map((record) => ({
      ...record, openTools: [...record.openTools],
    }))
  }

  #session(id) {
    let record = this.sessions.get(id)
    if (record) return record
    record = {
      session: { id, cwd: this.directory }, active: false, ended: false,
      tools: new Map(), approvals: new Map(), questions: new Map(),
    }
    this.sessions.set(id, record)
    if (this.sessions.size > this.maxSessions) {
      const entries = [...this.sessions.entries()]
      const victim = entries.find(([key, value]) => key !== id && !value.active)
        ?? entries.find(([key]) => key !== id)
      if (victim) this.sessions.delete(victim[0])
    }
    return record
  }

  handle(event) {
    if (!this.observes(event)) return []
    const props = event.properties ?? {}
    if (props.info?.id && event.type.startsWith('session.')) this.setSession(props.info)
    const id = this.sessionID(event)
    if (!id) return []
    if (event.type === 'session.deleted') {
      this.sessions.delete(id)
      this.onDispose?.(id)
      return this.reducer.disposeSession({ id })
    }
    const record = this.#session(id)
    const messages = []
    const emit = (type, data = {}) => {
      const normalized = { type, data, seq: ++this.sequence }
      messages.push(...this.reducer.handle(record.session, normalized))
      if (this.reducer.includeSubagents || record.session.header?.origin !== 'subagent') {
        this.onEvent?.(record.session, normalized)
      }
    }
    const begin = () => {
      if (record.active) return
      record.active = true
      record.ended = false
      record.tools.clear()
      record.approvals.clear()
      record.questions.clear()
      emit('turn/start')
    }
    const finish = (kind) => {
      if (record.ended || (!record.active && kind === 'completed')) return
      record.active = false
      record.ended = true
      record.approvals.clear()
      record.questions.clear()
      emit('turn/end', { reason: { kind } })
    }
    const showApproval = () => {
      const [approvalID, toolName] = record.approvals.entries().next().value ?? []
      if (approvalID && this.reducer.sessions.get(id)?.waitingApprovalId !== approvalID) {
        emit('approval/asked', { id: approvalID, toolName })
      }
    }

    switch (event.type) {
      case 'session.status':
        if (props.status?.type === 'idle') finish('completed')
        else if (['busy', 'retry'].includes(props.status?.type)) begin()
        break
      case 'session.idle':
        finish('completed')
        break
      case 'session.error':
        finish(props.error?.name === 'MessageAbortedError' ? 'aborted' : 'error')
        break
      case 'message.updated': {
        const info = props.info
        if (info?.role !== 'assistant') break
        if (info.error) {
          finish(info.error.name === 'MessageAbortedError' ? 'aborted' : 'error')
          break
        }
        // Completed historical messages and title generation cannot start work.
        if (!info.time?.completed) begin()
        break
      }
      case 'message.part.updated': {
        const part = props.part
        if (part?.type !== 'tool' || !part.callID) break
        const status = part.state?.status
        const previous = record.tools.get(part.callID)
        if (['pending', 'running'].includes(status)) {
          if (previous) break
          begin()
          record.tools.set(part.callID, 'running')
          emit('tool/call', { name: part.tool, callId: part.callID })
        } else if (['completed', 'error'].includes(status) && previous === 'running') {
          record.tools.set(part.callID, status)
          emit('tool/result', {
            callId: part.callID,
            ...(status === 'error' ? { error: { code: 'TOOL_ERROR' } } : {}),
          })
        }
        break
      }
      case 'todo.updated':
        emit('todo/write', { todos: props.todos })
        break
      case 'permission.updated': // Older OpenCode releases used this event name.
      case 'permission.asked': {
        begin()
        const key = props.id
        if (!key || record.approvals.has(key)) break
        const first = record.approvals.size === 0
        record.approvals.set(key, props.permission ?? props.type ?? 'permission')
        if (first) showApproval()
        break
      }
      case 'permission.replied': {
        const key = props.requestID ?? props.permissionID
        const first = record.approvals.keys().next().value
        if (!record.approvals.delete(key) || key !== first) break
        emit('approval/decided', { id: key })
        showApproval()
        break
      }
      case 'question.asked':
        begin()
        if (!props.id || record.questions.has(props.id)) break
        record.questions.set(props.id, props.tool?.callID ?? `question-${props.id}`)
        emit('tool/call', { name: 'ask_user', callId: record.questions.get(props.id) })
        break
      case 'question.replied':
      case 'question.rejected': {
        const callId = record.questions.get(props.requestID)
        if (!callId) break
        record.questions.delete(props.requestID)
        emit('tool/result', { callId })
        const next = [...record.questions.values()].at(-1)
        if (next) emit('tool/call', { name: 'ask_user', callId: next })
        break
      }
    }
    // A parallel tool result must not dismiss a pending permission request.
    if (record.approvals.size && !['permission.asked', 'permission.updated'].includes(event.type)) showApproval()
    return messages
  }
}
