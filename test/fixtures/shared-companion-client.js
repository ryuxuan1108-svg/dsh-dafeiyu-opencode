import { HelperProcess } from '../../src/helper-process.js'
import { SharedCompanion } from '../../src/opencode-shared.js'
import { OpenCodeEvents } from '../../src/opencode-events.js'
import { normalizeSettings } from '../../src/opencode-settings.js'

const notify = (message) => { if (process.connected) process.send(message) }
HelperProcess.prototype.start = function () { notify({ kind: 'helper-started' }) }
HelperProcess.prototype.send = function (message) { notify({ kind: 'helper-message', message }) }
HelperProcess.prototype.stop = function () { notify({ kind: 'helper-stopped' }) }
let shared
const events = new OpenCodeEvents({
  directory: process.env.BIGFISH_TEST_WORKSPACE,
  onEvent: (session, event) => shared.send({ type: 'event', session, event }),
})
shared = new SharedCompanion({
  identity: process.env.BIGFISH_TEST_IDENTITY,
  settings: normalizeSettings({ balanceEnabled: false, petEngine: 'native' }),
  openUrl: 'http://localhost:4096/', version: 'test',
  snapshot: () => events.snapshot(),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
})
process.on('message', async (command) => {
  if (command.type === 'event') events.handle(command.event)
  if (command.type === 'stop') {
    await shared.stop()
    notify({ kind: 'stopped' })
    process.disconnect()
  }
})
await shared.start()
notify({ kind: 'ready' })
