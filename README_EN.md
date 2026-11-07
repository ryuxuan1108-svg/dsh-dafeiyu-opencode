# OpenCode BigFish 🐋

A port of [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) from DeepSeek Harness to OpenCode. The native desktop companion follows real OpenCode session, tool, todo, permission, and question events. The interface is currently in Chinese.

[中文](README.md) · [Configuration and troubleshooting](docs/OPENCODE.md) · [Upstream DSH documentation](docs/DSH_EN.md)

## Install from source

This adapter targets the OpenCode **1.2.27 plugin API**. Clone this repository into a permanent directory. On Windows / Linux, install Python 3.11+ and run:

```sh
python -m pip install -r requirements.txt
```

Windows uses `py` by default. If only `python` is available, set `DSH_DAFEIYU_PYTHON` to its full path before launching OpenCode. On macOS, build the native helper with `npm run build:helper:darwin`; `npm run build:helper` builds the helper for the current platform. This source checkout does not include prebuilt helpers.

Append the local entry to the existing `plugin` array in your project or global OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///D:/project/dsh-dafeiyu-opencode/src/opencode.js"]
}
```

Replace the absolute path with your checkout location. On Linux / macOS, use a URL such as `file:///home/me/dsh-dafeiyu-opencode/src/opencode.js`. Quit and restart OpenCode. The companion runs beside the local OpenCode server used by Desktop, Web, or the terminal. A remote server displays the pet on the server's desktop.

The OpenCode entry requires only built-in Node modules and local source. Run `npm install --ignore-scripts --no-package-lock` for development and the full regression suite.

This port is loaded from local source. The upstream npm package `dsh-dafeiyu@0.1.23` contains the original DSH plugin. This checkout's root package export is now the OpenCode entry; the original DSH adapter remains available at `src/index.js` / `./dsh`.

The repository's [opencode.json](opencode.json) already loads the local entry when you start OpenCode from this checkout. Built helpers under `runtime/bin/` are ignored by Git and must be prepared separately on another machine.

## Features and settings

BigFish displays thinking, tool activity, waiting for permission or answers, errors, completion, todo progress, and multiple sessions. Child sessions are optional. Dragging, interactions, animation, sound controls, reduced motion, and optional DeepSeek / Sub2API balance display reuse the native helper.

Create `~/.config/opencode/dafeiyu.json` or `.opencode/dafeiyu.json`:

```json
{
  "scale": 1,
  "bubbleScale": 1,
  "soundStates": ["SUCCESS", "ERROR", "APPROVAL"],
  "includeSubagents": false,
  "balanceEnabled": true
}
```

Project values override global settings. Restart OpenCode after changing files. Size and reduced-motion changes from the native menu apply immediately and persist in separate OpenCode storage. See [configuration details](docs/OPENCODE.md) for all settings and logs.

For a Sub2API relay, add `"balanceType": "sub2api"` and `"balanceProvider": "subapi2"` to the same file, replacing `subapi2` with your OpenCode provider ID. The plugin reads that provider's URL and API key, then queries `/v1/usage`. Wallet balance, remaining key quota, subscription allowance, and unlimited plans are labeled separately. `subapi2` is also accepted as a balance type alias. Restart OpenCode after changing settings.

## Development

```sh
npm install --ignore-scripts --no-package-lock
node --test test/opencode-events.test.js test/opencode-plugin.test.js
npm test
npm run test:python
npm run test:opencode
```

Rebuild packaged helpers after changing Python / Swift. Run `swift test` for macOS core tests.

`test:opencode` requires an installed OpenCode executable. It uses isolated temporary configuration, a local mock model and Sub2API endpoint to verify real tools, todos, completion, balance display, and helper shutdown. Set `OPENCODE_BIN` to override the executable path.

Code and character assets have separate licenses. Read [LICENSE](LICENSE), [ASSET_LICENSE.md](ASSET_LICENSE.md), and the [asset license](assets/dsh-pet-LICENSE.txt).
