# MissClaude 模块接口（API v1）

桌宠对外是一个有**输入**和**输出**的模块：

```
                 ┌──────────────────────── MissClaude ────────────────────────┐
 输入            │                                                            │   输出
 say ──────────► │                                                            │
 act ──────────► │  PetController ──commands──► 渲染进程（行为 / 动画 / 气泡） │
 expression ───► │       ▲   │                                   │            │
 signal ───────► │  规则引擎 │                                   │ 交互 & 状态 │ ──► SSE  /v1/events
 Claude Code ──► │       └───┴────────── events ◄────────────────┘            │ ──► webhooks
 hook            │                                                            │ ──► /v1/events/recent
                 └────────────────────────────────────────────────────────────┘
```

- **指令**（say / act / expression / perform）：直接让她说话、做动作、换表情，或者把这些按时间轴编排成一段新表演。
- **信号 + 规则**（signal）：业务方只管推数据（比如 Claude 用量），什么条件下说什么、做什么，由
  `rules.json` 里的规则决定。业务模块里不用写判断逻辑。
- **事件**（events）：用户和她的每次交互、她的状态变化、说话、规则触发，都会以统一格式推送出来。

传输层是本机 HTTP + JSON。核心 `PetController`（`app/core/controller.js`）本身不依赖任何传输方式，
以后要嵌进别的 Node/Electron 进程，可以直接调用它的方法、订阅它的事件。

---

## 连接

| 项 | 值 |
|---|---|
| 地址 | `http://127.0.0.1:27826/v1`（默认只监听本机；跨机器见下面"从另一台电脑访问"） |
| 格式 | 请求体和响应都是 JSON（UTF-8） |
| 端口 | `settings.json` 里的 `apiPort` |
| WSL | 开了 `networkingMode=mirrored`，WSL 里直接用 `127.0.0.1` 就能访问 |
| 安全 | **带 `Origin` 头的请求一律返回 403**。浏览器发跨站请求一定会带这个头，所以网页没法操控她；curl、Python、hook 脚本不带，不受影响 |

> 为什么不用 47826 一类的端口：WSL 镜像网络会把 Linux 的临时端口段（本机是 44620–48715）在 Windows
> 侧整段预留，Windows 程序绑定这个范围里的端口会报 `EADDRINUSE`；49152 以上又是 Windows 的动态端口范围。

错误统一返回 `{"error": "说明"}`：参数错误 400、缺少或错误的 token 401、网页来源/远程不允许的路由 403、路由不存在 404。

### 从另一台电脑访问

桌宠是服务端，模型或脚本是客户端。默认只开本机，因为接口本身没有身份——谁连上端口谁就能让她说话。
要让 B 电脑上的程序驱动 A 电脑上的她：在 A 上右键她 → **允许其他电脑连接**。她会生成一个 token、改成监听所有网卡并重启，
同时打开一个 `connect.txt`（在 `%APPDATA%\MissClaude\`），里面有这台电脑的 IP、token、防火墙命令和 B 那边要设的
环境变量；之后菜单里的"连接信息…"可以再打开它。手工配等价于在 A 的 `settings.json` 里加两项再重启：

```json
{ "apiHost": "0.0.0.0", "apiToken": "一串随机的长字符串" }
```

- `apiHost`：`0.0.0.0` 监听所有网卡，或者只填某一块网卡的地址；**没有 `apiToken` 时不会对外监听**（日志里会说明，退回 127.0.0.1）。
- 不是本机发来的请求必须带 `Authorization: Bearer <apiToken>`，否则 401；本机的调用（hook 脚本、菜单）不用带。
- `/v1/admin/*` 和 `/v1/debug/*` 只接受本机，带了 token 也是 403。
- Windows 防火墙要放行这个端口（管理员 PowerShell）：
  `New-NetFirewallRule -DisplayName MissClaude -Direction Inbound -Protocol TCP -LocalPort 27826 -Action Allow`
- `GET /v1/state` 的 `api` 字段显示当前监听地址和是否要 token。

B 上：

```bash
export MISSCLAUDE_URL=http://192.168.1.20:27826 MISSCLAUDE_TOKEN=一串随机的长字符串
python3 clients/python/missclaude.py say "B 电脑来的问候"
curl -H "Authorization: Bearer $MISSCLAUDE_TOKEN" -X POST $MISSCLAUDE_URL/v1/signal \
     -H 'Content-Type: application/json' -d '{"name": "build", "value": {"status": "failed"}}'
```

不在一个局域网：两边装 Tailscale，B 用 A 的 Tailscale 地址（100.x.x.x）即可，防火墙规则照加；或者不开 `apiHost`，
在 B 上 `ssh -N -L 27826:127.0.0.1:27826 user@A`，把 A 的端口转到 B 本机。传输没有加密，token 走的是明文 HTTP，
所以只在可信网络（局域网、Tailscale）里用。

Claude Code 在 B 上时，把这两个变量写进 B 的 `~/.claude/settings.json`：

```json
{ "env": { "MISSCLAUDE_URL": "http://100.x.x.x:27826", "MISSCLAUDE_TOKEN": "……" } }
```

hook 脚本、`missclaude.py` 和 skill 都读这两个变量；`MISSCLAUDE_URL` 可以用逗号写多个地址，hook 事件会发给每一只桌宠。

---

## 输入

### `POST /v1/say` 说话

```json
{ "text": "额度用了一半啦", "expression": "surprised", "priority": "normal", "duration": 4 }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 最多 300 字，会以打字机效果显示在气泡里 |
| `expression` | 否 | 同时换上的表情：`happy` `surprised` `pout` `neutral` |
| `priority` | 否 | `normal`（默认）：如果她正在说别的外部消息，就排队（最多 5 条）；`high`：立刻打断 |
| `duration` | 否 | 打完字后气泡停留的秒数，默认按文字长度自动算 |

她自己的碎碎念（来源为 `self`）不会打断外部消息。**安静模式只屏蔽碎碎念**，API 和规则发来的话照常显示。

### `POST /v1/act` 动作

```json
{ "action": "walk", "dx": -200 }
```

| action | 说明 | 可选参数 |
|---|---|---|
| `wave` | 挥手（同时换开心脸） | `duration` |
| `work` | 工作模式：她往旁边让一步，书桌中间亮起一道竖直的光线，光线向两边展开，书桌和凳子在光里淡入；她跳上凳子坐下写字、时不时托腮思考；写够 `duration` 秒（默认 60）后，两道光边合拢，桌椅淡出 | `duration` |
| `work_end` | 提前结束工作，收拾桌椅 | |
| `cheer` | 开心地跳一下 | |
| `think` | 托腮思考 | `duration`（默认 3 秒） |
| `sit` | 坐下看书 | `duration` |
| `sleep` | 坐着睡着（会冒 Zzz） | `duration` |
| `wake` | 叫醒 | |
| `walk` | 走过去 | `x`：屏幕坐标（DIP）；或者 `dx`：相对当前位置的偏移；都不给就随机走 |
| `idle` | 回到站立待机 | |
| `chatter` | 随便说一句（时段问候或者碎碎念） | |

她正被拖着或者正在下落时，动作指令会被忽略。工作模式进行中只接受 `work`（延长时间）、`work_end`、`idle`（等同 `work_end`）和 `chatter`。

**动作库**：下面这些是带时间轴的连贯表演（手臂换姿势、表情、头身动作、台词、特效一起编排），同样通过 `/v1/act` 调用，
不需要额外参数。她空闲时也会自己挑其中一部分来做。

| action | 表演 | 时长 |
|---|---|---|
| `angry` 生气 | 双手叉腰、生气脸、跺两下脚（扬尘）、冒青筋和蒸汽，然后扭头撅嘴、脸红 | 4.2 s |
| `awkward` 尴尬 | 挠脸颊、眼神飘开、僵硬地笑、脸红，冒两滴汗 | 3.6 s |
| `smirk` 坏笑 | 手捂嘴、眯眼坏笑、肩膀偷偷抖，眼睛一闪；最后来个 wink | 3.4 s |
| `shy` 害羞 | 举书挡住脸，眼睛从书上偷看你一下又躲回去，冒爱心 | 3.8 s |
| `sad` 委屈 | 抱紧书、泪汪汪、低头，头顶飘阴影线，抽噎一下 | 4.0 s |
| `idea` 灵光一闪 | 托腮思考 → 灯泡亮起、"!"、跳一下 → 伸手指向答案 | 4.0 s |
| `cheer_on` 加油 | 握拳上下挥、连跳三下、闪光 | 3.2 s |
| `raise_hand` 举手 | 手举过头顶挥动、踮脚弹跳 | 3.0 s |
| `stretch` 伸懒腰 | 手举高、身体拉长后仰、闭眼发抖 → 捂嘴打哈欠 → 精神满满 | 4.6 s |
| `point` 你看那边 | 惊讶地伸手指向右上方、眼睛看过去 | 3.0 s |
| `giggle` 偷笑 | 捂嘴、眯眼笑、肩膀抖、脸红 | 2.8 s |
| `wink` | 握拳、wink、飞出星星 | 2.4 s |
| `dance` 跳舞 | 随节拍左右摇摆、手臂上下交替、每拍跳一下、飘音符 | 6.4 s |
| `proud` 得意 | 叉腰、仰起下巴、坏笑、闪光 | 3.4 s |
| `startled` 吓一跳 | 惊讶脸、高高跳起（"!"）→ 落地后挠头冒汗 | 3.4 s |
| `bored` 无聊 | 托腮、半闭眼、歪头叹气、"…" | 4.0 s |
| `confused` 疑惑 | 大幅歪头、挠头、冒问号 | 3.0 s |
| `sneeze` 阿嚏 | "阿……阿……" 后仰 → "阿嚏！" 前冲、花瓣喷出 → 揉鼻子、不好意思 | 3.4 s |
| `look_around` 东张西望 | 左看看、右看看、冒问号 | 3.4 s |
| `peek` 偷看书 | 把书举起来看 | 2.6 s |
| `hum` 哼歌 | 闭眼微笑、左右摇摆、飘音符 | 4.5 s |

### `POST /v1/expression` 表情

```json
{ "name": "happy", "duration": 3 }
```

`happy`（^ ^ 开心）、`surprised`（惊讶）、`pout`（鼓脸）、`angry`（生气）、`smirk`（坏笑）、`awkward`（尴尬）、
`teary`（泪汪汪）、`wink`（眨一只眼）、`blush`（脸红，叠加在当前脸上）、`neutral`（立刻恢复）。表情只在站姿、挥手这类姿势上显示；
坐着、走路、跳跃时她用的是该姿势自带的脸。

### `POST /v1/perform` 编排一段表演

不改程序就能做出新动作：把已有的积木（动作、表情、台词）按时间排好，她就按顺序演。

```json
{
  "name": "morning",
  "steps": [
    { "at": 0,   "action": "raise_hand", "say": "起床起床～", "priority": "high" },
    { "at": 3.2, "action": "cheer_on" },
    { "at": 3.4, "say": "新的一天，冲！", "expression": "happy", "duration": 3 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `steps[].at` | 相对开始的秒数，0–90，可乱序（会排序） |
| `steps[].action` / `say` / `expression` / `duration` / `priority` | 含义同 `/v1/act`、`/v1/say`、`/v1/expression`；每步至少有一项 |
| `name` | 出现在 `perform` 事件里 |

最多 24 步。返回 `{"ok": true, "steps": 3, "seconds": 3.4}`；开始和结束各发一个 `perform` 事件。
规则里也可以直接写 `steps`（见下文），`say` 里同样可以用 `{path}` 模板。

### `POST /v1/signal` 推送数据

```json
{ "name": "claude.usage", "value": { "percent": 83, "remaining_minutes": 95 } }
```

批量：

```json
{ "signals": { "claude.usage": { "percent": 83 }, "build.status": "red" } }
```

返回 `{"ok": true, "fired": ["usage-high"]}`，`fired` 是本次触发的规则 id。最新值会出现在 `/v1/state` 的 `signals` 里。

信号名和值的结构完全由你决定，规则用路径去读值。`claude.usage` 只是默认规则采用的一种约定：

| 字段 | 含义 |
|---|---|
| `percent` | 当前额度窗口已用的百分比（0–100） |
| `remaining_minutes` | 距离额度重置还有几分钟（可选） |
| 其他 | 随便加，比如 `tokens`、`cost_usd`，模板里都能用 |

#### 内置信号：`clock`

她自己每分钟推一次 `clock` 信号（启动时也推一次），不会出现在事件流里，但规则能用它。于是**闹铃、整点提醒、
到点下班**都只是一条规则，不需要任何外部程序：

```json
{ "time": "07:30", "hour": 7, "minute": 30, "weekday": 1, "date": "2026-10-23" }
```

`weekday` 0 是周日。例子：工作日早上七点半叫起床，`cooldown` 防止同一分钟内重复触发：

```json
{
  "id": "wake-up",
  "signal": "clock",
  "when": [
    { "path": "time", "op": "==", "value": "07:30" },
    { "path": "weekday", "op": ">=", "value": 1 },
    { "path": "weekday", "op": "<=", "value": 5 }
  ],
  "steps": [
    { "at": 0, "action": "raise_hand", "say": "{time} 啦！起床起床～", "priority": "high" },
    { "at": 3.2, "action": "cheer_on", "say": "新的一天，冲！" }
  ],
  "cooldown": 3600
}
```

`examples/alarm_demo.py` 会给下一分钟装一条这样的规则，并监听你点她（"贪睡"）。

### `POST /v1/hooks/claude-code` Claude Code hook

请求体就是 Claude Code hook 从 stdin 收到的那份 JSON，原样转发即可（脚本见
`integrations/claude-code/missclaude-hook.sh`）。她会这样反应：

| hook 事件 | 反应 |
|---|---|
| `SessionStart` | 挥手："开工啦！" |
| `UserPromptSubmit` | "收到！让我想想…"，进入工作模式（光线里展开桌椅，坐下写字、思考） |
| `PreToolUse` / `PostToolUse` | 进入（或保持）工作模式 |
| `Notification` | 举手（工作中则在桌前开心地抬头），气泡显示通知内容（太长就换成"需要你确认一下哦～"） |
| `Stop` | "搞定啦！"，桌椅收回光线里淡出，然后握拳加油 |
| `SubagentStop` | 冒几颗星星 |

---

## 规则

规则保存在 `%APPDATA%\MissClaude\rules.json`，**改完保存约 1.5 秒后自动生效**。也可以通过接口读写：

- `GET /v1/rules`：查看当前规则
- `PUT /v1/rules`：整体替换（会先校验，非法直接返回 400），同时写回 rules.json
- `POST /v1/rules/reset`：清空"上一次的值"和冷却记录，调规则或者重放测试数据时用

首次运行时会从 `app/core/default-rules.json` 复制一份默认规则（Claude 用量提醒）。

```json
{
  "id": "usage-high",
  "signal": "claude.usage",
  "when": [
    { "path": "percent", "op": ">=", "value": 80 },
    { "path": "percent", "op": "<", "value": 95 }
  ],
  "say": "额度已经用了 {percent}%，悠着点哦～",
  "expression": "surprised",
  "action": null,
  "priority": "high",
  "duration": null,
  "cooldown": 3600,
  "enabled": true
}
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，会出现在 `rule_fired` 事件里 |
| `signal` | 监听哪个信号 |
| `when` | 条件列表，**全部满足**才触发；可以省略（每次推送都触发，一般要配 cooldown） |
| `say` / `expression` / `action` / `steps` | 至少写一个。`say` 是模板：`{percent}` 从信号值里按路径取，`{a.b}` 可以取嵌套字段，`{}` 表示整个值；取不到时显示 `?`。`say` 也可以是一个列表，每次随机挑一句。`steps` 是一段表演（格式同 `/v1/perform`），写了 `steps` 就以它为准 |
| `priority` / `duration` | 同 `/v1/say` |
| `cooldown` | 触发后多少秒内不再触发 |
| `enabled` | 设成 `false` 可以临时停用 |

**条件运算符：**

| op | 类型 | 何时成立 |
|---|---|---|
| `>` `>=` `<` `<=` `==` `!=` | 电平 | 只要当前值满足就成立，一般要配 `cooldown`，否则每次推送都会触发 |
| `exists` | 电平 | 路径上有值（不是 null） |
| `crosses_above` | 边沿 | 上一次的值 `< value`，这一次 `>= value`。第一次推送不算 |
| `crosses_below` | 边沿 | 上一次 `> value`，这一次 `<= value` |
| `changed` | 边沿 | 和上一次的值不同 |

`action` 可以是任何动作，包括上面动作库里的表演。默认规则：用量越过 50% 时东张西望提一句；在 80–95% 之间每小时最多
提醒一次（尴尬地挠脸）；≥95% 时每 30 分钟提醒一次（委屈地抱着书）；从 10% 以上跌回 10% 以下（额度刷新）时握拳加油。

---

## 输出：事件

每个事件格式相同：

```json
{ "id": 42, "type": "click", "ts": "2026-10-22T08:51:14.954Z", "data": { "state": "idle" } }
```

`id` 单调递增；最近 200 条保存在内存里，可以补发。

| type | 何时发出 | data |
|---|---|---|
| `ready` | 渲染进程加载完成 | `renderer`（`webgl` 或 `2d`）、`rigs`（启用的分层骨骼，如 `["stand","walk","sit","drag"]`）、`sprites`、`faces` |
| `click` | 单击她（已经和双击区分开） | `state` |
| `double_click` | 双击 | `state` |
| `pet` | 在她头上来回摸 | `state` |
| `poke` | 4 秒内点了 5 次（她会鼓脸） | `count` |
| `drag_start` | 被鼠标拎起来 | `x` `y` |
| `drop` | 松手 | `x` `y` `vx` `vy`（甩出去的速度） |
| `land` | 落地 | `x` `y` `impact` |
| `wake` | 被叫醒或者自己醒来 | |
| `state` | 行为状态切换 | `from` `to`（idle / walk / sit / sleep / think / wave / cheer / act / work_in / work / work_out / drag / fall / land） |
| `action` | 动作库里的一个动作开始播放（自己挑的、交互触发的或 API 调用的） | `name` |
| `work` | 工作模式开始 / 结束 | `phase`：`start` / `end` |
| `speech` | 气泡出现 | `text`、`source`（self / menu / api / rule / claude_code） |
| `speech_end` | 气泡消失 | `text`、`interrupted` |
| `signal` | 收到一个信号 | `name` `value` |
| `rule_fired` | 规则触发 | `rule` `signal` `say` |
| `menu` | 在右键菜单或托盘菜单里选了某项 | `item` |
| `claude_code` | 收到 Claude Code hook | `event` |
| `perform` | 一段编排的表演开始 / 结束（API 调用的或规则触发的） | `name`、`phase`：`start` / `end` |

### 订阅方式

**SSE 实时流**：`GET /v1/events[?types=click,pet,drop]`

```
id: 42
event: click
data: {"id":42,"type":"click","ts":"…","data":{"state":"idle"}}
```

只推送订阅之后发生的事件。断线重连时带上 `Last-Event-ID`（或者 `?since=<id>`），会先补发错过的事件。
每 20 秒发一次 `: ping` 注释行保活。

**轮询**：`GET /v1/events/recent?since=<id>[&types=…]` 返回 `{"events": [...]}`。

**Webhook**：在 `settings.json` 里配置，每个事件 POST 一次（超时 2 秒，失败直接丢弃，不重试）：

```json
{ "webhooks": [ { "url": "http://127.0.0.1:9000/pet", "types": ["click", "pet", "rule_fired"] } ] }
```

---

## 查询

| 接口 | 返回 |
|---|---|
| `GET /v1/health` | `{"ok": true, "api": 1, "ready": true}` |
| `GET /v1/capabilities` | 当前角色（`character`）、支持的 actions、expressions、事件类型和说明、规则运算符、各种上限。接口本身是自描述的；换了角色包这些列表会不一样，先查再用 |
| `POST /v1/admin/restart` | 让正在运行的桌宠在自己所在的桌面会话里重启（部署更新后用）。返回 202 |
| `GET /v1/state` | `state`、`speaking`、`visible`、`character`、`foot`（屏幕坐标）、`size`、`quiet`、`rulesError`（rules.json 解析失败时的原因）、`signals`（每个信号的最新值） |

---

## Python 客户端

`clients/python/missclaude.py`，只依赖标准库，可以直接复制到别的项目里用：

```python
from missclaude import MissClaude

pet = MissClaude()                       # 或者 MissClaude("http://127.0.0.1:27826")
pet.say("你好～", expression="happy")
pet.act("walk", dx=-200)
pet.perform([{"at": 0, "action": "wave"}, {"at": 1.8, "say": "今天也加油！", "expression": "happy"}])
fired = pet.signal("claude.usage", {"percent": 83, "remaining_minutes": 95})

for ev in pet.events(types=["click", "pet", "drop"]):   # 阻塞迭代，断线自动续上
    if ev["type"] == "pet":
        pet.say("嘿嘿～")
```

命令行：

```bash
python3 clients/python/missclaude.py say "hello" --expression happy
python3 clients/python/missclaude.py signal claude.usage '{"percent": 83}'
python3 clients/python/missclaude.py events --types click,pet
python3 clients/python/missclaude.py state
python3 clients/python/missclaude.py perform '[{"at":0,"action":"wave"},{"at":1.5,"say":"hi"}]'
python3 examples/usage_demo.py          # 模拟用量一路涨到 99% 再刷新，看规则依次触发
python3 examples/alarm_demo.py          # 给下一分钟装一条闹铃规则，点她可以贪睡
```

## 接入 Claude Code

在 `~/.claude/settings.json`（或者项目的 `.claude/settings.json`）的 `hooks` 里，把想转发的事件指向这个脚本：

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/path/to/MissClaude/integrations/claude-code/missclaude-hook.sh" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/path/to/MissClaude/integrations/claude-code/missclaude-hook.sh" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "/path/to/MissClaude/integrations/claude-code/missclaude-hook.sh" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "/path/to/MissClaude/integrations/claude-code/missclaude-hook.sh" }] }]
  }
}
```

脚本超时 1 秒、始终返回 0。桌宠没运行时，Claude Code 不会被拖慢，也不会被拦住。建议每个 hook 加 `"async": true`，
`PreToolUse` / `PostToolUse` 也可以接上（她会坐到桌前干活）。

她对各事件的反应：`SessionStart` 打招呼；`UserPromptSubmit` 收到任务、坐到书桌前；工具调用期间一直在写字；
`Notification` 举手提醒你（短消息直接念出来）；**`Stop` 时把 Claude 这一轮回复的要点念出来**——脚本会从
hook 的 `last_assistant_message`（或 transcript）取最后一条回复，桌宠端把它压成一句（去掉 markdown，
取第一段的第一两句，最多 72 字）；`SubagentStop` 冒星星。

脚本认的环境变量：`MISSCLAUDE_URL`（默认 `http://127.0.0.1:27826`）、`MISSCLAUDE_TOKEN`（桌宠在别的电脑上时）。

反过来让 Claude Code **主动**使唤她（提醒、闹铃、播报），给它一个 skill 就行：仓库里的
`integrations/claude-code/SKILL.md` 复制到 `~/.claude/skills/missclaude/SKILL.md`，之后对 Claude Code 说
"三点半让桌宠叫我"，它会往她的规则里写一条 `clock` 规则——提醒由桌宠自己保管，Claude Code 退出了也照样响。
