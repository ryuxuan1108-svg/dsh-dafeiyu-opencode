import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const upstream = dirname(require.resolve('dsh-pet/package.json'))
const environment = join(root, 'runtime', 'dsh-pet', 'environment.js')
function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Upstream adapter anchor missing: ${before}`)
  return source.replace(before, after)
}
await build({
  entryPoints: [join(root, 'runtime/dsh-pet/engine.js')], outfile: join(root, 'dist/dsh-pet-engine.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
  alias: {
    '@deepseek-ai/dsh-home-paths': environment,
    '@deepseek-ai/dsh-credentials': join(upstream, 'src/standalone/shims/dsh-credentials.ts'),
    '@deepseek-ai/dsh-llm': join(upstream, 'src/standalone/shims/dsh-llm.ts'),
  },
  plugins: [{ name: 'opencode-host', setup(builder) {
    builder.onResolve({ filter: /^dsh-pet\/src\// }, (args) => ({ path: join(upstream, args.path.slice('dsh-pet/'.length)) }))
    builder.onResolve({ filter: /(?:^|\/)paths\.ts$/ }, (args) => {
      if (resolve(args.resolveDir, args.path) === join(upstream, 'src/host/paths.ts')) return { path: environment }
    })
    builder.onLoad({ filter: /[\\/]host[\\/]helper[\\/]electron\.ts$/ }, async ({ path }) => ({
      loader: 'ts', contents: `import { petHome, PET_HELPER_MAIN } from ${JSON.stringify(environment)};\n`
        + replace(replace(replace(await readFile(path, 'utf8'), "return process.env.DSH_HOME || join(userProfile, '.dsh');", 'return petHome();'),
          'export const DESKTOP_DEBUG_PORT = 0;', 'export const DESKTOP_DEBUG_PORT = Number(process.env.OPENCODE_DAFEIYU_DESKTOP_DEBUG_PORT || 0);'),
          "resolve(packageRoot, 'runtime', 'electron-helper', 'main.js')", 'PET_HELPER_MAIN'),
    }))
    builder.onLoad({ filter: /[\\/]plugin[\\/]desktop[\\/]spawn\.ts$/ }, async ({ path }) => ({
      loader: 'ts', contents: `import { runtimeOptions } from ${JSON.stringify(environment)};\n`
        + replace(replace(replace(await readFile(path, 'utf8'), "process.env.DSH_PET_IN_PROCESS === '1'", 'runtimeOptions().headless === true'),
          'resolveOpenTarget(siteUrl, isDesktopHost())', "'standalone'"),
          "const result = await getHandlePetRoute()(req.url ?? '/', req.method ?? 'GET', req.body);",
          "const result = await getHandlePetRoute()(req.url ?? '/', req.method ?? 'GET', req.body);\n          runtimeOptions().onDesktopRequest?.(req.url, result);"),
    }))
    builder.onLoad({ filter: /[\\/]plugin[\\/]setup\.ts$/ }, async ({ path }) => ({
      loader: 'ts', contents: `import { runtimeOptions } from ${JSON.stringify(environment)};\n`
        + replace(replace(await readFile(path, 'utf8'), '  return {\n    userRoot,', '  const setup = {\n    userRoot,'),
          '    nextExternalWorkSeq,\n  };\n}', '    nextExternalWorkSeq,\n  };\n  runtimeOptions().onSetup?.(setup);\n  return setup;\n}'),
    }))
    builder.onLoad({ filter: /[\\/]host[\\/]config[\\/]read\.ts$/ }, async ({ path }) => ({
      loader: 'ts', contents: `import { singlePet } from ${JSON.stringify(environment)};\n`
        + replace(await readFile(path, 'utf8'), '  return out;\n}\n\n/** 拍平', '  return singlePet(out);\n}\n\n/** 拍平'),
    }))
    builder.onLoad({ filter: /[\\/]host[\\/]helper[\\/]child\.ts$/ }, async ({ path }) => ({
      loader: 'ts', contents: `import { trackChild, petHome } from ${JSON.stringify(environment)};\n`
        + replace(replace(await readFile(path, 'utf8'), '    this.child = child;', '    this.child = child; trackChild(child);'),
          "  delete env.ELECTRON_RUN_AS_NODE;", "  delete env.ELECTRON_RUN_AS_NODE;\n  env.DSH_HOME = petHome();"),
    }))
    builder.onLoad({ filter: /[\\/]settings-page[\\/]chrome\.ts$/ }, async ({ path }) => ({
      loader: 'ts', contents: (await readFile(path, 'utf8'))
        .replace(/<form id="settings"[\s\S]*?<\/form>/, '<p class="fineprint">模型与余额跟随 OpenCode，无需重复填写密钥。上游：PC2005-cloud/dsh-pet。</p>')
        .replace('独立模式</div>', 'OpenCode 大肥鱼</div>'),
    }))
    builder.onLoad({ filter: /[\\/]settings-page[\\/]script[\\/]boot\.ts$/ }, async ({ path }) => ({
      loader: 'ts', contents: (await readFile(path, 'utf8'))
        .replace('  mountProtocolSelect();', '').replace('  mountBalanceSelect();', '')
        .replace('  wireAiPanel();', '').replace('  loadAi();', ''),
    }))
  } }],
})
console.log('Built dsh-pet@0.4.7 engine with OpenCode host adapters: dist/dsh-pet-engine.js')
