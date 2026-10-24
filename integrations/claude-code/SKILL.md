---
name: missclaude
description: 控制桌面上的桌宠（MissClaude / 腊肠）：让它说话、做动作、定时提醒（闹铃）、播报数据。用户说"让桌宠/她/小狗提醒我…"、"到点叫我"、"让桌宠说…"、"通知桌宠"时用。
---

# 桌宠接口

桌宠在本机跑一个 HTTP 服务：`http://127.0.0.1:27826/v1`（文档：`<仓库路径>/docs/API.md`）。
命令行客户端：`python3 <仓库路径>/clients/python/missclaude.py`。
桌宠没运行时请求会失败，告诉用户即可，不要重试很多次。

先 `… state` 看它在不在、现在是哪个角色（`character`：`claude` 她 / `lachang` 小狗）；`… capabilities` 列出可用动作和表情。

## 常用

| 想做什么 | 命令 |
|---|---|
| 说一句话 | `missclaude.py say "文本" [--expression happy] [--duration 秒] [--priority high]` |
| 做动作 | `missclaude.py act <动作名>`（她：wave sit sleep think work cheer_on angry …；小狗：bark wag sit lie beg howl …） |
| 一段表演 | `POST /v1/perform`：`{"steps":[{"at":0,"action":"raise_hand"},{"at":1,"say":"到时间了！","expression":"happy"}]}` |
| 推数据让规则决定 | `missclaude.py signal <名字> '<json>'`，例如 `signal build '{"status":"failed"}'` |

气泡约 13 个汉字宽、最多 300 字：要说的话写短；长内容说一句摘要。

## 定时提醒（闹铃）

桌宠自己每分钟发一个 `clock` 信号，所以**提醒交给桌宠自己保管**，Claude Code 退出了也照样响。
加一条规则（读出现有规则，追加，整体写回）：

```bash
B=http://127.0.0.1:27826/v1
curl -s $B/rules | python3 -c '
import json,sys
r=json.load(sys.stdin)["rules"]
r=[x for x in r if x["id"]!="remind-1530"]
r.append({"id":"remind-1530","signal":"clock","when":[{"path":"time","op":"==","value":"15:30"}],
          "say":"到 15:30 了，该去开会啦！","action":"raise_hand","priority":"high","cooldown":3600})
print(json.dumps({"rules":r},ensure_ascii=False))' | curl -s -X PUT $B/rules -H 'Content-Type: application/json' --data-binary @-
```

`when` 可用 `path`：`time`（"HH:MM"）、`hour`、`minute`、`weekday`（0 周日…6）、`date`（"YYYY-MM-DD"）。
一次性提醒加 `"date"` 条件，并在触发后（或下次）把这条规则删掉。只过几分钟的倒计时，也可以直接 `sleep N && missclaude.py say …`。

## 跨机器

桌宠在别的电脑上时：`MISSCLAUDE_URL=http://<ip>:27826 MISSCLAUDE_TOKEN=<token>`（对方 settings.json 里的 `apiHost`/`apiToken`）。
