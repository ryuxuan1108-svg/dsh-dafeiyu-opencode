# OpenCode 接入与配置

本移植以 OpenCode 1.2.27 的公开插件接口为基准，入口为 `src/opencode.js`，只导出一个插件函数。包根路径和 `./opencode` 指向此入口；`./dsh` 保留上游入口。安装方法见 [README](../README.md)。

## 以 dsh-pet 为主体

默认 `petEngine: "dsh-pet"` 直接使用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) **0.4.7** 的宿主逻辑、Electron 窗口、动画和设置页。`npm run build:pet` 将上游宿主源码与 OpenCode 适配器构建成 `dist/dsh-pet-engine.js`；安装依赖时使用 `npm install --legacy-peer-deps --ignore-scripts --no-package-lock`。已有仓库更新后需要重新安装依赖、构建，并重启 OpenCode。

默认模式不需要 Python。上游在首次启动时自动准备 Electron，缓存在全局配置目录的 `pet-runtime/electron/`。旧的 Qt / Swift 桌宠可通过 `"petEngine": "native"` 使用，对应平台仍需原来的 Python 或原生 Helper。

右键桌宠的「打开 AI 设置」进入上游聊天 / 配置界面，可调整外观、物理、动画、人设、语音和待办。模型和 API Key 统一读取 OpenCode，界面不再要求重复填写服务商密钥。主界面资源、菜单、拖拽甩抛、动作点播、睡觉和提醒逻辑沿用上游。

数据默认保存在 `~/.config/opencode/pet-runtime/dsh-pet/`，支持 `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`：

| 路径 | 内容 |
| --- | --- |
| `main-config.jsonc` | 上游桌宠配置，保存后即时生效 |
| `memory.json` | 聊天历史与记忆 |
| `todos.json` | 个人待办和到期时间，与 OpenCode Agent 的任务清单分别保存 |
| `attachments/` | 内容哈希去重的聊天图片 |
| `pet/` | 上游格式的角色包 |
| `logs.txt` | 上游引擎运行日志 |
| `opencode-runtime.json` | 当前设置页地址与端口，仅运行时存在，包含本机访问凭据 |

`petId` 默认 `main`。角色包和实例沿用上游格式，配置中有多只时仅显示选中的一只，找不到该 ID 时选择第一只。所有工作区共用同一个引擎和这份用户数据；Electron 的浏览器缓存也与 DSH 安装隔离。

聊天和手动碎碎念通过当前工作区的 OpenCode 模型执行，尚未观察到模型选择时回落到 `small_model` / 默认模型。每次使用禁止全部工具的临时会话，模型不会借聊天执行项目工具；结束后删除临时会话，历史由上游保存。聊天图片上限 650KB / 2,000 万像素，是否能看图取决于所选模型。

自动碎碎念和语音朗读默认关闭，可以在图形设置中开启。朗读沿用上游在线 Edge TTS，需要可用网络。OpenCode 当前没有提供 DSH 的语音识别服务，麦克风输入会显示上游的“不支持”提示；不会伪装转写成功。移动端重力传感器和 DSH 页面内浮层属于上游浏览器环境，当前默认接入为桌面模式。

## 工作区与全局加载

跨工作区使用时，在**全局** `~/.config/opencode/opencode.json` 注册插件。Windows 默认位置为 `C:\Users\你的用户名\.config\opencode\opencode.json`。向现有配置合并以下字段，路径替换为实际仓库位置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///D:/project/dsh-dafeiyu-opencode/src/opencode.js"]
}
```

项目中的 `opencode.json` 只在该项目生效。全局 `dafeiyu.json` 是桌宠设置文件，不会注册插件；因此只设置全局余额仍可能出现“换工作区没有反应”。配置全局入口后，其他工作区即可加载同一份插件和全局余额设置。仓库位置需保持有效，移动仓库后同步更新入口地址。

OpenCode 仍按工作区加载插件，但同一个全局配置目录下的工作区和本机 OpenCode 进程现在**共用一只大肥鱼**。各工作区通过本机管道连接到同一个 Helper，统一汇总任务；等待确认和错误优先，其次显示进行中的任务，同优先级显示最近更新的任务。不同工作区即使出现同名会话也会分别处理。

关闭一个工作区只移除它的任务；最后一个工作区断开时关闭共享 Helper。若持有 Helper 的 OpenCode 进程意外退出，其余进程会重新连接并恢复当前任务状态，恢复过程不会重复播放旧的完成提示音或审批提醒。

模型与余额跟随当前显示任务对应的工作区；上游引擎统一调度余额刷新。上游外观与人设使用共享用户配置。可以在某个项目的 `.opencode/dafeiyu.json` 设置 `"enabled": false`，让该工作区不参与桌宠状态显示。

如果全局和项目都注册同一入口，请使用指向同一个源文件的地址；OpenCode 1.2.27 会去重。修改全局或项目配置后，**完全退出并重新启动 OpenCode**，以便已经打开的工作区重新加载。

## 事件映射

| OpenCode 事件 | 大肥鱼行为 |
| --- | --- |
| `session.status` busy / retry | 开始或继续思考 |
| `message.part.updated` tool pending / running | 根据工具类型显示查找、修改、执行等状态 |
| tool completed / error | 回到思考或其他运行中的工具；工具失败提示错误 |
| `todo.updated` | 显示待办内容与实际完成步数 |
| `permission.asked` / `permission.replied` | 等待审批、可选审批提示音，回答后恢复 |
| `question.asked` / replied / rejected | 等待用户回答，回答或取消后恢复 |
| `session.status` idle / `session.idle` | 本轮完成，只提示一次 |
| `session.error` | 错误；用户中断则显示已停止 |
| `session.deleted` | 移除该会话并选择其他任务 |
| `server.instance.disposed` / `global.disposed` | 断开该工作区；最后一个工作区断开后停止共享 Helper |

模型的 `step-finish` 可能表示即将执行工具，因此不作为任务完成信号。适配器按顺序处理事件；通过 SDK 获取会话目录和 `parentID`，默认排除子会话。提示不会包含工具参数、工具输出、模型原文或上游原始错误。

## 设置文件

加载顺序为全局 `dafeiyu.json` → 项目 `.opencode/dafeiyu.json` → 支持选项参数的加载器传入值。全局目录默认 `~/.config/opencode`，支持 `XDG_CONFIG_HOME` 和 `OPENCODE_CONFIG_DIR`。环境变量 `OPENCODE_DAFEIYU_CONFIG` 可以指定唯一设置文件的路径。

这些是插件自己的设置，放在独立文件里。OpenCode 1.2.27 的 `opencode.json` 中只需要配置 `plugin` 数组。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启动桌宠 |
| `petEngine` | `"dsh-pet"` | 上游引擎；`native` 为原有 Qt / Swift 兼容模式 |
| `petId` | `"main"` | 选中的上游宠物 ID，始终只显示一只 |
| `scale` | `1` | 角色大小，0.55–1.4 |
| `bubbleScale` | `1` | 气泡大小，0.8–1.2 |
| `activityLevel` | `"normal"` | `quiet`、`normal`、`lively` |
| `reducedMotion` | `false` | 减少动画 |
| `soundEnabled` | `true` | 声音总开关 |
| `soundStates` | `["SUCCESS","ERROR"]` | 可选 `SUCCESS`、`ERROR`、`APPROVAL` |
| `bubbleMode` | `"always"` | `always`、`hidden`、`custom` |
| `bubbleStates` | `["SUCCESS","ERROR","WAITING"]` | custom 模式显示的状态 |
| `includeSubagents` | `false` | 是否显示子 Agent |
| `balanceEnabled` | `true` | 是否查询余额 / 剩余额度 |
| `balanceType` | `"auto"` | `auto`、`deepseek`、`sub2api`；也接受 `subapi2` 写法 |
| `balanceProvider` | `""` | OpenCode 服务商 ID；空值时自动选择 |
| `openUrl` | OpenCode 提供的服务地址 | 右键“打开 OpenCode”的目标，支持 HTTP(S) 或 OpenCode 协议 |

例如，将右键菜单指向正在使用的 Web 客户端：

```json
{
  "openUrl": "http://127.0.0.1:4096/",
  "balanceEnabled": false,
  "bubbleMode": "custom",
  "bubbleStates": ["WAITING", "SUCCESS", "ERROR"]
}
```

修改 OpenCode 接入设置后完全退出并重新启动 OpenCode。上表的 `scale` 等原生外观选项用于 `native` 模式；上游模式的外观、动作、气泡和语音在上游设置页调整，第一次建立配置时迁移角色大小和余额开关。`dafeiyu-user-settings.json` 保留原生模式的菜单设置。

OpenCode 1.2.27 的标准插件接口提供事件和工具钩子。默认模式提供上游独立设置页和桌宠聊天界面；DSH 客户端内部的侧栏注入仍只属于 DSH。

## DeepSeek 余额

支持 DeepSeek API 余额。优先使用 OpenCode `provider.deepseek.options.apiKey`，其次 `DEEPSEEK_API_KEY`，再尝试 SDK `config.providers()` 返回的 DeepSeek Key。网关地址读取 `provider.deepseek.options.baseURL` 或 `DEEPSEEK_BASE_URL`，默认 `https://api.deepseek.com`，并请求 `/user/balance`。

仅支持实现该余额接口的网关。OpenCode 没有 DSH 的已登录账户服务，因此这里使用 API Key 余额。没有凭据时显示“余额未配置”，任务状态仍可使用。每分钟刷新一次，可设 `balanceEnabled: false` 关闭。余额和错误提示不包含密钥。

如果同时配置了 Sub2API 和 DeepSeek，想固定查询 DeepSeek，可在 `dafeiyu.json` 设置 `"balanceType": "deepseek"`。

## Sub2API / subapi2 余额

支持 Sub2API 官方的 `GET /v1/usage` 接口，使用中转站 API Key 认证，自动读取该服务商在 OpenCode 中的地址和 Key。不需要中转站后台的登录密码或登录 Token。

在项目 `.opencode/dafeiyu.json` 或全局 `~/.config/opencode/dafeiyu.json` 配置：

```json
{
  "balanceEnabled": true,
  "balanceType": "sub2api",
  "balanceProvider": "subapi2"
}
```

`balanceProvider` 必须填写 **OpenCode 服务商 ID**，即 `opencode.json` 的 `provider` 对象中的键，不是模型名称，也不是站点网址。例如已配置 `provider.my-relay`，这里就填 `"my-relay"`。`balanceType` 的 `"subapi2"` 写法也会识别为 Sub2API。

Key 优先读取该服务商的 `options.apiKey`，其次 `SUB2API_API_KEY`，再读取 OpenCode SDK 中保存的该服务商 Key。地址读取该服务商的 `options.baseURL` / `api` 或 `SUB2API_BASE_URL`。也支持 `SUBAPI2_API_KEY`、`SUBAPI2_BASE_URL` 别名。

地址可以填写站点根地址或带 `/v1` 的地址，例如 `https://relay.example`、`https://relay.example/v1`。代理子路径会保留，插件自动拼接 `/v1/usage?days=1`，每分钟查询一次。`days=1` 用于缩小接口附带的每日用量明细。站点需提供这一接口；接口不存在时显示查询失败。

局域网中转站使用 HTTP 时，请显式填写 `balanceProvider`，插件会沿用这个服务商在 OpenCode 中已配置的 HTTP 地址。自动发现服务商时仍使用 HTTPS 或本机 HTTP。

| 上游计费方式 | 桌宠显示 |
| --- | --- |
| 钱包余额 | `Sub2API 账户余额 $12.50` |
| Key 总额度或滚动时间窗额度 | `Sub2API Key 可用额度 $8.00`；同时有限额时显示其中最小剩余值 |
| 日 / 周 / 月订阅套餐 | `Sub2API 套餐剩余额度 $5.00` |
| 套餐未设置额度上限 | `Sub2API 套餐不限额` |

Key 限额和套餐额度按上游返回显示，与钱包余额分别标记；没有返回数字时不会显示成零。查询失败保留上次成功结果并标明“上次查询”；凭据失效则清除旧结果。插件只向桌宠传递整理后的余额数据，不传递 Key、原始用量明细或套餐名称。

默认上游引擎的余额刷新和失败气泡沿用 dsh-pet 的处理；上述“上次查询”缓存标记适用于 native 模式。接口提供额度上限与已用量时会按实际百分比驱动上游余额档位动画，只有钱包余额时不猜测“已用百分比”。

默认 `balanceType: "auto"` 会优先识别服务商 ID / 名称中的 `sub2api`、`subapi2`，优先选择当前模型对应的匹配服务商，随后查找其他匹配服务商，未匹配时使用 DeepSeek。自定义名称建议显式设置 `balanceType` 和 `balanceProvider`。指定 `sub2api` 而省略服务商 ID 时，会尝试匹配的服务商或配置中的当前模型服务商。

修改后**完全退出并重新启动 OpenCode**。参考实现：[Sub2API 网关接口](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/gateway_handler.go)。

## Helper 与日志

Helper 复用上游跨平台启动、心跳、快照重放和有限重试逻辑。源码运行需要 Python 和 `requirements.txt` 中的 PySide6；macOS 可构建 Swift Helper。构建后会优先使用 `runtime/bin/` 中的原生程序。环境变量继续使用 `DSH_DAFEIYU_*`，以兼容现有 Helper：

- `DSH_DAFEIYU_PYTHON`：Python 解释器路径。
- `DSH_DAFEIYU_LOG_FILE`：Helper 日志路径，`off` 关闭。
- `DSH_DAFEIYU_HEADLESS=1`：协议开发模式，不显示窗口。
- `DSH_DAFEIYU_EVENT_LOG`：开发时记录桌宠协议消息的 JSONL 路径。

默认日志位置：Windows `%LOCALAPPDATA%\dsh-dafeiyu\logs\helper.log`；macOS `~/Library/Logs/dsh-dafeiyu/helper.log`；Linux `${XDG_STATE_HOME:-~/.local/state}/dsh-dafeiyu/helper.log`。插件自身诊断通过 OpenCode `client.app.log()` 写入宿主日志。

使用终端客户端时，“打开 OpenCode”默认打开宿主提供的 HTTP 地址。需要浏览器界面时，使用 `opencode web`，或启动可访问的 `opencode serve` 并将 `openUrl` 指向它。远程或无图形桌面的服务进程需要在本地运行服务才能看到原生窗口。

OpenCode 1.2.27 使用随机端口时可能向插件提供端口 `0`，这种情况下菜单回退到 `http://127.0.0.1:4096/`。如果你的服务使用其他端口，请明确配置 `openUrl`。
