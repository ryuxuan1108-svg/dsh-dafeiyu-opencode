// Build-time aliases keep dsh-pet's data separate from any DSH installation.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const PACKAGE_ROOT = dirname(require.resolve('dsh-pet/package.json'))
export const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, 'assets')
export const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, 'memes')
export const PET_HELPER_MAIN = fileURLToPath(new URL('../runtime/dsh-pet/electron-main.cjs', import.meta.url))
let options = {}
const children = new Set()
export function configureRuntime(next) { options = next }
export function runtimeOptions() { return options }
export function petHome() { return options.home || join(homedir(), '.config', 'opencode', 'pet-runtime') }
export { petHome as resolveDshHome }

export function singlePet(config) {
  const pets = Object.values(config).flatMap((entry) => entry.pets || [])
  const selected = pets.find((pet) => pet.id === options.settings?.petId) || pets[0]
  for (const entry of Object.values(config)) entry.pets = (entry.pets || []).filter((pet) => pet === selected)
  return config
}

export function trackChild(child) {
  children.add(child)
  options.onChild?.()
  child.once('exit', () => children.delete(child))
}
export function killChildren() { for (const child of children) child.kill() }
export function desktopProcesses() { return [...children].map((child) => child.pid) }
export async function waitForChildren() {
  const pending = [...children]
  await Promise.all(pending.map((child) => new Promise((done) => {
    if (child.exitCode !== null) return done()
    const timer = setTimeout(() => { child.kill('SIGKILL'); done() }, 3500)
    child.once('exit', () => { clearTimeout(timer); done() })
  })))
}
