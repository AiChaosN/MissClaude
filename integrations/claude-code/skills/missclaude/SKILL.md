---
name: missclaude
description: 控制桌面上的桌宠（MissClaude / 腊肠犬 lachang）：让它说话、做动作、定时提醒（闹铃）、播报数据。用户说"让桌宠/她/小狗提醒我…"、"到点叫我"、"让桌宠说…"、"通知桌宠"时用。
---

# 桌宠接口

桌宠是本机（或局域网里另一台电脑）上的一个 HTTP 服务。先算出地址和鉴权头：

```bash
B="${MISSCLAUDE_URL:-http://127.0.0.1:27826}"; B="${B%%,*}/v1"      # 多个地址时取第一个
H=(-H 'Content-Type: application/json'); [ -n "${MISSCLAUDE_TOKEN:-}" ] && H+=(-H "Authorization: Bearer $MISSCLAUDE_TOKEN")
```

`MISSCLAUDE_URL` / `MISSCLAUDE_TOKEN` 没设就是本机默认端口、不需要 token。桌宠没运行时请求会失败：告诉用户即可，不要反复重试。

先看它在不在、是谁：`curl -s "${H[@]}" $B/state`（`character`：`claude` 她 / `lachang` 小狗）；`curl -s $B/capabilities` 列出可用动作和表情。

## 常用

| 想做什么 | 请求 |
|---|---|
| 说一句话 | `curl -s "${H[@]}" -X POST $B/say -d '{"text":"文本","expression":"happy","duration":3,"priority":"high"}'`（后三项可省） |
| 做动作 | `curl -s "${H[@]}" -X POST $B/act -d '{"action":"wave"}'`（她：wave sit sleep think work cheer_on angry …；小狗：bark wag sit lie beg howl …） |
| 一段表演 | `POST $B/perform`：`{"steps":[{"at":0,"action":"raise_hand"},{"at":1,"say":"到时间了！","expression":"happy"}]}` |
| 推数据让规则决定 | `POST $B/signal`：`{"name":"build","value":{"status":"failed"}}` |

气泡约 13 个汉字宽、最多 300 字：要说的话写短；长内容说一句摘要。

## 定时提醒（闹铃）

桌宠自己每分钟发一个 `clock` 信号，所以**提醒交给桌宠自己保管**，Claude Code 退出了也照样响。
加一条规则（读出现有规则，追加，整体写回）：

```bash
curl -s "${H[@]}" $B/rules | python3 -c '
import json,sys
r=json.load(sys.stdin)["rules"]
r=[x for x in r if x["id"]!="remind-1530"]
r.append({"id":"remind-1530","signal":"clock","when":[{"path":"time","op":"==","value":"15:30"}],
          "say":"到 15:30 了，该去开会啦！","action":"raise_hand","priority":"high","cooldown":3600})
print(json.dumps({"rules":r},ensure_ascii=False))' | curl -s "${H[@]}" -X PUT $B/rules --data-binary @-
```

`when` 可用 `path`：`time`（"HH:MM"）、`hour`、`minute`、`weekday`（0 周日…6）、`date`（"YYYY-MM-DD"）。
一次性提醒加 `"date"` 条件，并在触发后（或下次）把这条规则删掉。只过几分钟的倒计时，也可以直接 `sleep N` 再 `say`。

完整接口见仓库的 `docs/API.md`（https://github.com/AiChaosN/MissClaude）。
