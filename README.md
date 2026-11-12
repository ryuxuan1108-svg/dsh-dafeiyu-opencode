# OpenCode 大肥鱼 🐋

以 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 为主体的 OpenCode 桌宠。默认直接运行 **dsh-pet 0.4.7 的完整桌面引擎**，本项目负责 OpenCode 会话、模型、余额和跨工作区单实例连接。

[English](README_EN.md) · [详细配置与排错](docs/OPENCODE.md) · [上游 DSH 说明](docs/DSH.md)

动画、物理交互、睡觉、聊天记忆、表情包和待办由上游提供。原 [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) 的 Qt / Swift 引擎保留为 `native` 兼容模式。

## 功能

- 上游 100 多段透明动画、随机动作、动作点播、点击回应、拖拽甩抛与弹弓交互。
- 思考、工作、等待确认、完成和出错状态，跟随 OpenCode 的真实会话事件。
- OpenCode 待办进度、多会话显示，可选择显示子 Agent。
- 多个工作区和本机 OpenCode 进程共用一只大肥鱼，统一显示需要处理的任务。
- Electron 透明置顶窗口、系统托盘、多屏活动和图形设置页。
- 右键睡觉 / 唤醒、待办清单与到期提醒、宠物聊天、持久化记忆和图片 / 表情包。
- 使用 OpenCode 当前模型聊天和碎碎念，可选上游 Edge 语音朗读；自动碎碎念和语音默认关闭。
- 可选 DeepSeek / Sub2API 余额显示，读取 OpenCode 的服务商配置；Sub2API 区分钱包余额、Key 额度和订阅套餐。
- 随 OpenCode 实例停止；Helper 意外退出时使用原有恢复机制。

插件在 OpenCode 的本地服务进程中运行，桌面端、Web 和终端使用同一套接入。连接远程服务时，原生窗口显示在运行服务的机器上。当前接入面向 OpenCode **1.2.27 的插件接口**。

## 从源码安装

1. 将此仓库克隆到固定目录。
2. 安装依赖并构建上游引擎：

   ```powershell
   npm install --legacy-peer-deps --ignore-scripts --no-package-lock
   npm run build:pet
   ```

   默认引擎不需要 Python。首次启动会由上游自动准备 Electron，之后复用本机缓存。使用 `--legacy-peer-deps` 是因为 DSH 宿主依赖已由本项目的 OpenCode 适配器替代。也可以使用 `pnpm install --frozen-lockfile` 后运行构建。

3. 推荐在**全局** `~/.config/opencode/opencode.json` 中，向已有 `plugin` 数组追加本地入口，让每个工作区都能加载。Windows 默认路径为 `C:\Users\你的用户名\.config\opencode\opencode.json`：

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       "file:///D:/project/dsh-dafeiyu-opencode/src/opencode.js"
     ]
   }
   ```

   请替换为实际绝对路径。Linux / macOS 示例为 `file:///home/me/dsh-dafeiyu-opencode/src/opencode.js`。如果只需要某个项目启用，也可以把入口放在该项目的 `opencode.json`；项目配置支持相对路径。仓库根目录提供 [opencode.example.json](opencode.example.json)。

4. **完全退出并重新启动 OpenCode**。原生大肥鱼会自动出现，打开会话并执行任务即可观察状态。

右键大肥鱼选择「打开 AI 设置」即可进入上游的聊天与配置页，里面可以调整外观、物理、人设、语音和待办。聊天模型和余额凭据复用 OpenCode，不需要再次填写 API Key。

当前移植通过本地源码加载；上游 npm 的 `dsh-dafeiyu@0.1.23` 是 DSH 版本。包根入口已指向 OpenCode，原 DSH 入口保留在 `src/index.js` / 包子路径 `./dsh`。

本仓库的 [opencode.json](opencode.json) 已配置好本地入口。默认引擎的构建产物为 `dist/dsh-pet-engine.js`；它和 `node_modules/` 不入 Git，其他机器按上述步骤安装、构建。

**其他工作区没有反应时，先检查全局的 `plugin` 注册。** `dafeiyu.json` 只保存桌宠设置和余额选项；把它放到全局不会自动加载插件。跨工作区需要全局的插件入口和全局的桌宠设置，修改后完全退出并重启 OpenCode。详见 [工作区与全局加载](docs/OPENCODE.md#工作区与全局加载)。

## 设置

OpenCode 接入选项放在全局 `~/.config/opencode/dafeiyu.json` 或项目 `.opencode/dafeiyu.json`；项目设置覆盖全局设置：

```json
{
  "enabled": true,
  "petEngine": "dsh-pet",
  "petId": "main",
  "includeSubagents": false,
  "balanceEnabled": true
}
```

上游图形设置即时生效，保存到 `~/.config/opencode/pet-runtime/dsh-pet/main-config.jsonc`。聊天记忆、图片和待办也保存在该目录，不与 DSH 安装混用。文件宠物包沿用上游格式，但按 `petId` 只显示一只。完整设置见 [配置说明](docs/OPENCODE.md)。

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
npm install --legacy-peer-deps --ignore-scripts --no-package-lock
node --test test/opencode-events.test.js test/opencode-plugin.test.js
npm test
npm run test:python
npm run test:opencode
npm run test:pet
```

`npm test` 会先构建上游引擎。`test:pet` 使用真实 OpenCode 和本地模拟模型 / Sub2API 验证上游引擎、睡觉、待办、聊天记忆、余额及单实例；`test:opencode` 验证保留的 native 兼容模式。`node scripts/test-pet-visual.mjs` 可运行真实桌面截图检查。

`test:opencode` 需要已安装 OpenCode，使用隔离的全局配置、两个临时工作区和本地模拟模型 / Sub2API 接口验证只启动一个共享 Helper、跨工作区任务和余额、关闭首个工作区后继续使用，以及最后一个工作区退出时关闭桌宠。可通过 `OPENCODE_BIN` 指定 OpenCode 可执行文件路径。

## 授权

主要引擎、动画及交互来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，代码使用 MIT 许可证；角色形象与新素材遵循上游说明的 CC BY-NC-SA 4.0。原生兼容引擎来自 QCYTSN/dsh-dafeiyu。请阅读 [LICENSE](LICENSE)、[上游代码许可证](vendor/dsh-pet-LICENSE.txt) 和 [素材授权说明](ASSET_LICENSE.md)。
