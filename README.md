# OpenCode 大肥鱼 🐋

将 [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) 的 DeepSeek Harness 桌宠移植到 OpenCode。大肥鱼根据 OpenCode 的会话、工具、审批、提问和待办事件显示真实工作状态，在桌面上陪你工作。

[English](README_EN.md) · [详细配置与排错](docs/OPENCODE.md) · [上游 DSH 说明](docs/DSH.md)

<img src="docs/images/balance-preview.png" width="460" alt="大肥鱼原生窗口示意；截图来自上游 DSH，余额为演示数据">

## 功能

- 思考、查找、修改、执行、等待确认、完成和出错状态。
- OpenCode 待办进度、多会话显示，可选择显示子 Agent。
- 原生透明置顶窗口，支持拖动、摸头、戳身体、尾巴互动。
- 大小、气泡、动作频率、减少动态、提示音与审批通知设置。
- 可选 DeepSeek / Sub2API 余额显示，读取 OpenCode 的服务商配置；Sub2API 区分钱包余额、Key 额度和订阅套餐。
- 随 OpenCode 实例停止；Helper 意外退出时使用原有恢复机制。

插件在 OpenCode 的本地服务进程中运行，桌面端、Web 和终端使用同一套接入。连接远程服务时，原生窗口显示在运行服务的机器上。当前接入面向 OpenCode **1.2.27 的插件接口**。

## 从源码安装

1. 将此仓库克隆到固定目录。
2. 准备原生 Helper。Windows / Linux 源码运行需要 Python 3.11+ 和 PySide6：

   ```powershell
   python -m pip install -r requirements.txt
   ```

   如果 Windows 只有 `python` 而没有 `py`，启动 OpenCode 前指定解释器：

   ```powershell
   $env:DSH_DAFEIYU_PYTHON = (Get-Command python).Source
   ```

   macOS 推荐执行 `npm run build:helper:darwin`；其他平台也可执行 `npm run build:helper` 构建独立 Helper。源码仓库不包含预编译 Helper。

3. 在项目的 `opencode.json` 或全局 `~/.config/opencode/opencode.json` 中，向已有 `plugin` 数组追加本地入口：

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       "file:///D:/project/dsh-dafeiyu-opencode/src/opencode.js"
     ]
   }
   ```

   请替换为实际绝对路径。Linux / macOS 示例为 `file:///home/me/dsh-dafeiyu-opencode/src/opencode.js`。项目配置也可以使用相对路径。仓库根目录提供 [opencode.example.json](opencode.example.json)，用于复制到仓库内的 `opencode.json`。

4. **完全退出并重新启动 OpenCode**。原生大肥鱼会自动出现，打开会话并执行任务即可观察状态。

OpenCode 入口只依赖 Node 内置模块和仓库代码。开发、运行完整回归测试及维护 DSH 适配时，先执行 `npm install --ignore-scripts --no-package-lock`。

当前移植通过本地源码加载；上游 npm 的 `dsh-dafeiyu@0.1.23` 是 DSH 版本。包根入口已指向 OpenCode，原 DSH 入口保留在 `src/index.js` / 包子路径 `./dsh`。

本仓库的 [opencode.json](opencode.json) 已配置好本地入口；在仓库目录启动 OpenCode 时会加载大肥鱼。Windows Helper 构建产物位于 `runtime/bin/win32-x64/`，该目录由 Git 忽略，其他机器需按上述步骤准备 Helper。

## 设置

在全局 `~/.config/opencode/dafeiyu.json` 或项目 `.opencode/dafeiyu.json` 创建普通 JSON 文件。项目设置覆盖全局设置：

```json
{
  "enabled": true,
  "scale": 1,
  "bubbleScale": 1,
  "activityLevel": "normal",
  "reducedMotion": false,
  "soundEnabled": true,
  "soundStates": ["SUCCESS", "ERROR", "APPROVAL"],
  "bubbleMode": "always",
  "includeSubagents": false,
  "balanceEnabled": true
}
```

文件修改后重启 OpenCode。右键菜单中的大小、气泡大小和减少动态会即时生效并保存到 OpenCode 的独立设置文件。完整选项、打开客户端地址、余额来源和日志位置见 [配置说明](docs/OPENCODE.md)。

使用 **Sub2API / subapi2** 中转站时，在同一个 `dafeiyu.json` 中加入：

```json
{
  "balanceEnabled": true,
  "balanceType": "sub2api",
  "balanceProvider": "subapi2"
}
```

将 `balanceProvider` 改为你在 OpenCode 中配置的服务商 ID。插件会读取该服务商的地址和 API Key，通过 `/v1/usage` 查询；修改后重启 OpenCode。服务商选择、环境变量和计费类型见 [Sub2API 说明](docs/OPENCODE.md#sub2api--subapi2-余额)。

## 开发验证

```powershell
npm install --ignore-scripts --no-package-lock
node --test test/opencode-events.test.js test/opencode-plugin.test.js
npm test
npm run test:python
npm run test:opencode
```

原生 Helper 与动画素材沿用上游实现；修改 Python / Swift 后需要重新构建已打包的 Helper。macOS 核心测试使用 `swift test`。

`test:opencode` 需要已安装 OpenCode，使用隔离的临时配置和本地模拟模型 / Sub2API 接口验证真实工具、待办、完成事件、余额显示及 Helper 退出。可通过 `OPENCODE_BIN` 指定 OpenCode 可执行文件路径。

## 授权

角色素材来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。代码和素材适用不同授权，请阅读 [LICENSE](LICENSE)、[ASSET_LICENSE.md](ASSET_LICENSE.md) 和 [素材许可证](assets/dsh-pet-LICENSE.txt)。
