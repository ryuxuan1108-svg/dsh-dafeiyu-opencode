# OpenCode BigFish 🐋

An OpenCode integration built around [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet). The default engine is the upstream **dsh-pet 0.4.7** desktop application, including its animation library, physics, sleep, reminders, chat memory, images, and optional voice output. The interface is currently in Chinese.

[中文](README.md) · [Configuration and troubleshooting](docs/OPENCODE.md) · [Upstream DSH documentation](docs/DSH_EN.md)

## Install from source

This adapter targets the OpenCode **1.2.27 plugin API**. Clone this repository into a permanent directory, then install and build:

```sh
npm install --legacy-peer-deps --ignore-scripts --no-package-lock
npm run build:pet
```

The default engine does not require Python. Upstream prepares and caches Electron on its first launch. The DSH peer dependencies are replaced by the OpenCode host adapters, hence `--legacy-peer-deps`.

For every workspace, append the local entry to the existing `plugin` array in your global `~/.config/opencode/opencode.json`. On Windows this defaults to `C:\Users\your-name\.config\opencode\opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///D:/project/dsh-dafeiyu-opencode/src/opencode.js"]
}
```

Replace the absolute path with your checkout location. On Linux / macOS, use a URL such as `file:///home/me/dsh-dafeiyu-opencode/src/opencode.js`. Quit and restart OpenCode. The companion runs beside the local OpenCode server used by Desktop, Web, or the terminal. A remote server displays the pet on the server's desktop.

To enable it for one project, put the entry in that project's configuration. A global `dafeiyu.json` contains settings only; the plugin must also be registered globally to react in other workspaces.

Use the pet's “打开 AI 设置” context menu to open its chat and graphical configuration. Models and balance credentials come from OpenCode. Automatic chatter and voice output are disabled by default.

This port is loaded from local source. The upstream npm package `dsh-dafeiyu@0.1.23` contains the original DSH plugin. This checkout's root package export is now the OpenCode entry; the original DSH adapter remains available at `src/index.js` / `./dsh`.

The repository's [opencode.json](opencode.json) loads the local entry. Build `dist/dsh-pet-engine.js` on another machine after installing dependencies. The former Qt / Swift engine remains available through `"petEngine": "native"` and retains its Python / packaged-Helper requirements.

## Features and settings

BigFish uses upstream's transparent animation library, dragging and throwing physics, sleep/wake, todos, chat history, images and memes, and optional Edge TTS. Real OpenCode tasks and DeepSeek / Sub2API balances are provided by this integration. Speech recognition requires a compatible host speech service and is currently reported as unavailable.

Workspaces and local OpenCode processes using the same global configuration directory share one native companion. It combines their tasks, prioritizes pending approvals and errors, and exits when the last workspace disconnects. If the process owning the Helper exits, the remaining workspaces reconnect and restore their current state.

Create `~/.config/opencode/dafeiyu.json` or `.opencode/dafeiyu.json`:

```json
{
  "petEngine": "dsh-pet",
  "petId": "main",
  "includeSubagents": false,
  "balanceEnabled": true
}
```

Project values override global settings. Restart OpenCode after changing integration settings. Upstream graphical settings apply live and are saved under `~/.config/opencode/pet-runtime/dsh-pet/`, alongside memory, attachments and todos. The selected `petId` is the only visible pet, including when additional packs are installed. See [configuration details](docs/OPENCODE.md).

For a Sub2API relay, add `"balanceType": "sub2api"` and `"balanceProvider": "subapi2"` to the same file, replacing `subapi2` with your OpenCode provider ID. The plugin reads that provider's URL and API key, then queries `/v1/usage`. Wallet balance, remaining key quota, subscription allowance, and unlimited plans are labeled separately. `subapi2` is also accepted as a balance type alias. Restart OpenCode after changing settings.

## Development

```sh
npm install --legacy-peer-deps --ignore-scripts --no-package-lock
node --test test/opencode-events.test.js test/opencode-plugin.test.js
npm test
npm run test:python
npm run test:opencode
npm run test:pet
```

`npm test` builds the upstream engine first. `test:pet` validates the default engine through real OpenCode with local mock services; `test:opencode` covers native compatibility. Run `node scripts/test-pet-visual.mjs` for the desktop screenshot check.

`test:opencode` requires an installed OpenCode executable. It uses isolated global configuration, two temporary workspaces, a local mock model and Sub2API endpoint to verify one shared Helper, tasks and balances from both workspaces, continued operation after the first workspace closes, and shutdown after the last workspace disconnects. Set `OPENCODE_BIN` to override the executable path.

The primary engine is MIT-licensed [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet); its current artwork follows upstream's CC BY-NC-SA 4.0 notice. The legacy native engine comes from QCYTSN/dsh-dafeiyu. Read [LICENSE](LICENSE), [the upstream code license](vendor/dsh-pet-LICENSE.txt), and [ASSET_LICENSE.md](ASSET_LICENSE.md).
