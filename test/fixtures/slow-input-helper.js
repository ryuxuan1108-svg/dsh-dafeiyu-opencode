import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

process.stdout.write(`${JSON.stringify({ protocolVersion: 1, kind: 'ready' })}\n`)
process.stdin.pause()
setTimeout(() => {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    appendFileSync(process.env.BIGFISH_INPUT_LOG, `${message.kind}\n`)
    if (message.kind === 'shutdown') process.exit(0)
  })
}, 200)
