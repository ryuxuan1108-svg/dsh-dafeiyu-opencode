import { dirname, join } from 'node:path'
import { appendFileSync } from 'node:fs'

export class DshPetHelper {
  constructor(options, logger) {
    this.options = options
    this.logger = logger
    this.queue = Promise.resolve()
  }
  start() {
    this.ready = import('../dist/dsh-pet-engine.js').then(({ createPetEngine }) => createPetEngine({
      home: join(dirname(this.options.identity), 'pet-runtime'), settings: this.options.settings,
      logger: this.logger, request: this.options.request, context: this.options.context,
      headless: process.env.OPENCODE_DAFEIYU_PET_HEADLESS === '1',
    })).then((engine) => { this.engine = engine; return engine })
    this.ready.catch(() => this.logger.error?.('dsh-pet 引擎启动失败，请先运行 npm run build:pet 并检查日志。'))
    return this.ready
  }
  send(message) {
    this.queue = this.queue.then(async () => {
      const engine = await this.ready
      if (message.kind === 'config' && this.options.context) engine.updateContext(this.options.context)
      await engine.send(message)
      if (process.env.DSH_DAFEIYU_EVENT_LOG) appendFileSync(process.env.DSH_DAFEIYU_EVENT_LOG, JSON.stringify(message) + '\n')
    }).catch(() => this.logger.warn?.('dsh-pet 未能处理一条桌宠消息，请检查运行日志。'))
  }
  async stop() {
    try {
      await this.queue
      const engine = await this.ready
      await engine.stop()
      if (process.env.DSH_DAFEIYU_EVENT_LOG) appendFileSync(process.env.DSH_DAFEIYU_EVENT_LOG, JSON.stringify({ kind: 'shutdown' }) + '\n')
    } catch {}
  }
  kill() { this.engine?.kill() }
}
