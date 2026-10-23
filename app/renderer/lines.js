// What she says. Keep lines short: the bubble is ~13 characters wide.

export const LINES = {
  hello: ['你好呀～我是 Claude！', '嗨～今天也一起加油吧！', '我来啦～需要帮忙随时叫我'],
  click: ['嘿嘿～', '怎么啦？', '我在呢～', '被你发现了！', '要休息一下吗？', '今天的实验顺利吗？'],
  poke: ['别戳啦！', '哼…再戳就不理你了', '戳坏了要赔的！'],
  pet: ['嘿嘿，好舒服～', '再摸摸～', '(｡>﹏<｡)'],
  chatter: [
    '今天的 query plan 跑得怎么样？',
    'cardinality 又估错了吗？',
    '要不要一起读篇论文？',
    '喝口水，休息一下眼睛吧～',
    '代码写完记得跑测试哦',
    'Let me think step by step…',
    'PostgreSQL 的 planner 我可熟了！',
    '老大加油！',
    '这本书叫《Database System Concepts》',
    'join order 的搜索空间好大呀…',
  ],
  read: ['这本书好有意思…', '嗯…原来是这样', '（翻页）'],
  sleepy: ['唔…有点困了…', '哈啊～（打哈欠）'],
  wake: ['我、我没睡着！', '唔…早上好？', '欸？刚刚发生了什么'],
  drag: ['哇啊！放我下来！', '要带我去哪里呀？', '飞起来啦～'],
  land: ['哎哟！', '安全着陆～', '吓我一跳…'],
  think: ['让我想想…', '嗯……', '唔，这个问题有意思'],
  // actions (actions.js)
  angry: ['哼！我生气了！', '不许再戳啦！', '气鼓鼓！'],
  pout: ['不理你了…', '哼…', '除非你哄哄我'],
  awkward: ['啊哈哈……', '这、这个嘛……', '嘿嘿，那个……'],
  smirk: ['嘿嘿嘿～', '我知道你的小秘密哦～', '哼哼～有好戏看了'],
  shy: ['别、别一直看着我啦…', '好害羞…', '呜…不要看'],
  sad: ['呜……', '有点委屈…', '才、才没有哭'],
  idea: ['啊！我知道了！', '有了有了！', '灵光一闪！'],
  cheer: ['加油加油！', '你一定可以的！', '冲呀～'],
  raise: ['我我我！', '这里这里～', '老师我知道！'],
  stretch: ['嗯～～～', '伸个懒腰～'],
  yawn: ['哈啊～', '好困……'],
  refresh: ['精神满满！', '好啦，继续！'],
  point: ['你看那边！', '那是什么？', '快看快看！'],
  giggle: ['噗嗤～', '嘻嘻', '忍不住笑了'],
  wink: ['交给我吧☆', '嘿嘿☆', '包在我身上！'],
  dance: ['♪～', '啦啦～'],
  dance2: ['啦啦啦～', '转个圈～♪'],
  proud: ['哼哼，厉害吧～', '不愧是我！', '夸我夸我～'],
  startled: ['哇啊？！', '吓！', '呀！'],
  startled2: ['吓、吓我一跳……', '刚刚是什么…', '心跳好快…'],
  bored: ['好无聊啊……', '有没有好玩的事呀…', '唉……'],
  confused: ['诶？', '嗯？怎么回事', '咦？'],
  sneeze1: ['阿……阿……'],
  sneeze2: ['阿嚏！'],
  sneeze3: ['嘿嘿……', '谁在想我？', '失礼了…'],
  hum: ['♪～', '哼哼～♪', '啦～啦～♪'],
  // the work routine
  workStart: ['开工啦！', '准备工作！', '桌子桌子，出来吧～'],
  workPop: ['嘿咻！', '坐好～', '噔噔～'],
  workWrite: ['写写写……', '嗯嗯，这样就好', '记下来记下来'],
  workThink: ['这里要怎么写呢……', '嗯……', '让我想想'],
  workHappy: ['完成一段！', '写得不错！', '顺利顺利～'],
  workClick: ['在忙呢～', '等我写完这段', '嘿嘿，我在认真工作哦'],
  workDone: ['收工～', '搞定啦！', '辛苦啦～'],
  // Claude Code hook events
  ccStart: ['开工啦！', '新的一轮，冲！'],
  ccPrompt: ['收到！让我想想…', '好的，交给我吧～'],
  ccWork: ['翻翻代码…', '在看了在看了…', '查一下资料…'],
  ccDone: ['搞定啦！', '完成～快来看看吧！', '好啦，看看结果？'],
  ccAttention: ['需要你确认一下哦～', '等你回复～', '这里要你拍板啦'],
};

export function pick(kind) {
  const arr = LINES[kind] || [];
  return arr[Math.floor(Math.random() * arr.length)] || '';
}

// A greeting that depends on the time of day, or null if nothing special.
export function timeGreeting(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 6 && h < 10) return '早上好！今天也要元气满满～';
  if (h >= 11.5 && h < 13.5) return '到饭点啦，记得吃饭～';
  if (h >= 17.5 && h < 19) return '傍晚啦，晚饭吃什么呢？';
  if (h >= 0 && h < 5) return '已经很晚了，早点休息吧…';
  return null;
}
