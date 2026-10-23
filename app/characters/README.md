# 角色包（character packs）

一个角色一个文件夹。引擎（`app/engine/`、`app/core/`、`app/main.js`）不认识任何具体角色：
窗口比例、菜单、能做的动作、骨骼怎么动、待机时干什么，全部来自角色包。启动时用设置里的
`character`（默认 `claude`）选包；装了多个包时右键菜单会多一项"角色"。

```
app/characters/<name>/
  character.json   主进程和接口读的声明：名字、窗口比例、尺寸、菜单、动作/表情列表
  index.js         渲染进程读的模块：Pet 子类、posers、skins、各种表（见下）
  behaviour.js     Pet 子类：角色自己的状态和反应
  posers.js        每种骨骼的 poser（参数 → 骨骼角度）和额外的蒙皮方式
  actions.js       动作库：带时间轴的表演（导出 ACTIONS / ACTION_NAMES / pickIdleAction / validateActions）
  lines.js         台词（导出 pick(kind)，可选 timeGreeting()）
  assets/          manifest.json、精灵、表情补丁、rig_*.json 和分层贴图、tray.png / tray@2x.png
```

## character.json

```json
{
  "name": "claude",
  "title": "MissClaude",
  "window": { "aspect": [1.8, 1.75], "footY": 0.16 },
  "sizes": { "small": 150, "medium": 200, "large": 260 },
  "menu": [{ "label": "打个招呼", "action": "wave" }],
  "actions": ["idle", "wave", "sit", "walk", "chatter"],
  "library": ["angry", "awkward"],
  "expressions": ["happy", "surprised", "pout"]
}
```

- `window.aspect`：窗口宽、高相对于角色身高的倍数；`footY`：脚离窗口底部多高（也是身高的倍数）。
  窗口要装得下角色所有姿势（跳起、拖拽时甩动的东西），`tools/record.py` 录一遍能看出有没有贴边。
- `sizes`：三档身高（DIP）。
- `menu`：右键菜单顶部的几项，每项发一个 `act`。
- `actions`：`POST /v1/act` 接受的基础动作（引擎自带 `idle`、`walk`、`chatter`、`wake`，其余是角色自己的状态）；
  `library`：`actions.js` 里的表演（测试会核对两边一致）；`expressions`：`setExpression` 接受的表情（`neutral` 引擎自带）。

## index.js

默认导出一个对象：

| 字段 | 作用 |
|---|---|
| `Pet` | `engine/pet.js` 的 `Pet` 子类（见下） |
| `posers` | `{ 骨骼种类: (bones, t, params) => void }`，键对应 `rig_*.json` 的 `kind` |
| `skins` | 除 `rigid` / `chain` 之外的蒙皮函数 `(x, y, spec, vertexIndex) => {bone: weight}` |
| `paramDefaults` | 骨骼参数的初值（数值参数都会被缓动） |
| `variantParams` | 变体组 → 选变体的参数名（不写则同名） |
| `headBone` | 表情补丁跟随的骨骼（默认 `head`）；`faceGroups` 让某组补丁跟别的骨骼 |
| `rigFor` | 精灵名 → 画它的骨骼名；没有骨骼的精灵整图绘制 |
| `faceSets` | 精灵名 → 用哪套表情补丁 |
| `walk` | `{ speed, stride }`：步速（DIP/s，中号）和步长/身高，要和 walk poser 的腿摆幅匹配 |
| `shadowWidth` | 精灵名 → 接触阴影宽度/身高 |
| `busyStates` | 不接受待机决策和大多数反应的状态 |
| `pettable` | 摸头有效的状态 |
| `reactions` | 引擎通用反应用到的动作名：`poke`、`thrown`（列表）、`doubleClick`、`petted`、`click`（列表）、`attention`、`done` |
| `actions`、`pickIdleAction`、`lines` | 动作库和台词 |

## Pet 子类

引擎负责：窗口几何、状态机、`idle` / `walk` / `drag` / `fall` / `land` / `act` 这几个状态、
说话气泡和口型、眨眼、鼠标（点击、双击、连点、摸头、拖拽）、接口指令、渲染。角色包在子类里加自己的状态
（方法名 `enter_<state>` / `update_<state>`，`update` 里设置 `this.view`），并按需覆盖这些钩子：

| 方法 | 默认行为 | 改它做什么 |
|---|---|---|
| `greet()` | 说一句问候 | 出场动作 |
| `decide()` | 走走、做个表演、瞟一眼、碎碎念 | 待机时的决策表 |
| `interruptIdle()` | 不打断 | 有事要做时离开待机（返回 true） |
| `rigParams(kind, rig)` | 走路相位、拖拽、表演里的参数、眼神 | 把状态/表情/表演映射成骨骼参数 |
| `specialFaces(set, F)` | `null`（用标准的表情/眼睛/嘴） | 某套补丁有自己的规则（看书、睡觉） |
| `eyesUp()` | `false` | 某个姿势要用 `look_up` 补丁 |
| `actFx()` | 围绕头和脚的特效位置 | 五官位置不同时挪特效 |
| `reactClick()` / `onDoubleClick()` / `onPetted()` / `pout()` | 通用反应 | 角色自己的反应 |
| `act(action, opts)` | 引擎的动作，其余查动作库 | 先处理自己的基础动作再 `super.act()` |
| `onClaudeCode(event, text)` | 说话 + 一个表演 | Claude Code hook 的反应 |
| `startDrag()` | 拎起 | 被拎起前收拾现场（先做再 `super.startDrag()`） |

约定的精灵名：`idle`（站姿，决定布局）、`walk`、`drag`（被拎起，锚点在头）；约定的骨骼名：`stand`、`walk`、`drag`；
睡着的状态叫 `sleep`（点一下会醒）。`setProps(rigName, x0, x1, opacity)` / `slit()` 可以让某个骨骼的道具层
（`propView`）在两道光之间自己出现（Claude 的书桌就是这么来的）。

## 校验

- `node --test tests/`：每个包的 `character.json` 和 `actions.js` 对得上。
- `python3 tools/regress.py record base.json <name>` / `compare`：固定随机数逐帧比像素，改引擎时拿它证明没动到别的角色。
- `python3 tools/record.py`、`tools/preview.py`：录动图、截图看效果（`?character=<name>`）。
