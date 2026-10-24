# companion：把一个 Claude Code 会话变成她本人

```bash
cd companion && claude --model haiku
```

然后直接和她聊：这个会话里 Claude 以她的身份回话，每句都通过桌宠的气泡说出来，配表情和动作；
"三点半叫我"会存成她自己的闹铃。Haiku 够用、便宜、快。

和普通会话的区别只有两处：`.claude/settings.json` 把 `MISSCLAUDE_MIRROR=0` 写进环境（这个会话的工具调用不再让她坐到书桌前），
`CLAUDE.md` 告诉模型它就是她。桌宠在哪台电脑、token 是什么，仍然来自 `~/.claude/settings.json` 的 `env`。

前提：装了仓库里的 Claude Code 插件（`/plugin marketplace add AiChaosN/MissClaude` → `/plugin install missclaude@missclaude`）。
