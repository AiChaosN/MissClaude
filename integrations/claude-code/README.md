# Claude Code 插件：missclaude

把 Claude Code 接到桌宠上。装好之后：

- 你一提问，她坐到书桌前写字；Claude 调用工具期间一直在干活；需要你确认时她举手（短消息直接念出来）。
- **每轮回复结束，她念一句总结**：hook 取 Claude 的最后一条回复，用一个小模型（`claude -p --model haiku`，几秒钟，
  不拖慢 Claude Code）按她的口吻压成一句不超过 20 字的话；压不出来就由桌宠端截取第一句。切到腊肠犬时口吻会带"汪"。
- Claude Code 学会使唤她（skill `missclaude`）：对它说"三点半让桌宠叫我"、"让小狗汪一声"，它会调桌宠的接口，
  闹铃会存成桌宠自己的 `clock` 规则，Claude Code 退出了也照样响。

## 安装

```
/plugin marketplace add AiChaosN/MissClaude
/plugin install missclaude@missclaude
```

或者在本地克隆后：`claude plugin marketplace add /path/to/MissClaude`，再 `claude plugin install missclaude@missclaude`。
装完 `/reload-plugins` 或重开会话。`/plugin` 里可以随时停用或卸载。

需要本机有 `python3`、`curl`；模型总结需要 `claude` 命令本身（就是你在用的这个）。

## 桌宠在别的电脑上

在那台电脑上右键她 → "允许其他电脑连接"，拿到 `connect.txt` 里的地址和 token，写进这边的 `~/.claude/settings.json`：

```json
{ "env": { "MISSCLAUDE_URL": "http://100.x.x.x:27826", "MISSCLAUDE_TOKEN": "……" } }
```

hook 和 skill 都读这两个变量。`MISSCLAUDE_URL` 可以用逗号写多个地址，hook 事件会发给每一只桌宠。

## 可调

| 变量 | 作用 |
|---|---|
| `MISSCLAUDE_URL` | 桌宠地址（默认 `http://127.0.0.1:27826`） |
| `MISSCLAUDE_TOKEN` | 远程桌宠的 token |
| `MISSCLAUDE_SUMMARY=0` | 关掉模型总结，改为桌宠端截取第一句 |
| `MISSCLAUDE_SUMMARY_MODEL` | 总结用的模型（默认 `haiku`） |
| `MISSCLAUDE_MIRROR=0` | 这个会话什么都不转发（`companion/` 里"以她的身份聊天"的会话用它） |

## 里面有什么

```
.claude-plugin/plugin.json      插件清单
hooks/hooks.json                七个事件都指向 hooks/missclaude-hook.sh（async；Stop 给 60 秒做总结）
hooks/missclaude-hook.sh        把 hook 的 JSON 转发给桌宠；Stop 时附上回复的总结
skills/missclaude/SKILL.md      教 Claude Code 怎么用桌宠，以及"作为她本人聊天"时怎么表现
skills/missclaude/pet.sh        模型用的命令行：state / say / act / expr / perform / signal / remind / forget / events，自己读地址和 token
```

不想装插件也可以手工配：hook 命令指向这个脚本的绝对路径，skill 复制到 `~/.claude/skills/missclaude/`。
