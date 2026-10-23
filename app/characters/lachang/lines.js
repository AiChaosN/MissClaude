// What the dachshund says. Short lines: the bubble is ~13 characters wide.

export const LINES = {
  hello: ['汪！我是腊肠～', '汪汪！你回来啦！', '汪～今天也一起玩吧！'],
  click: ['汪？', '摸摸我～', '要出去玩吗？', '汪汪！', '有零食吗？', '在呢在呢～'],
  poke: ['呜…别戳啦', '汪！！', '再戳就咬你哦', '汪汪汪！'],
  pet: ['呼噜呼噜～', '好舒服…汪', '再摸一下！', '尾巴停不下来了～'],
  chatter: [
    '今天的骨头真香～',
    '老大加油！汪！',
    '好想出去散步呀…',
    '那边…是不是有只猫？',
    '肚子有点饿了…',
    '汪？有人敲门？',
    '我的尾巴呢…在哪？',
    '晒太阳最舒服了～',
    '我是一条很长的狗',
    '快写完了吗？汪',
  ],
  sit: ['坐好了！', '我乖乖的～', '等零食中…'],
  lie: ['好无聊…', '趴一会儿', '唉…'],
  beg: ['给一口嘛～', '汪？就一口', '我可以表演坐下！'],
  sleepy: ['呼…好困…', '哈欠～汪…'],
  wake: ['汪！谁！', '唔…我没睡', '欸？天亮了？'],
  drag: ['汪汪汪！放我下来！', '要去哪里呀？', '我、我会飞？'],
  land: ['汪！', '哎哟…', '吓死狗了'],
  // actions (actions.js)
  bark: ['汪！', '汪汪！', '汪汪汪！'],
  growl: ['呜…', '汪！不许戳！', '呜呜呜…'],
  howl: ['嗷呜～', '嗷——呜～'],
  tilt: ['汪？', '嗯？', '那是什么？'],
  bow: ['来玩嘛～', '追我呀！', '陪我玩！'],
  sniff: ['嗅嗅…', '这是什么味道？', '闻到零食了！'],
  sad: ['呜…', '没人理我…', '汪…（委屈）'],
  wag: ['汪汪～', '开心！', '尾巴停不下来～'],
  shake: ['哗啦哗啦！', '抖一抖～'],
  yawn: ['哈——欠', '有点困了…'],
  smirk: ['嘿嘿…', '我知道零食藏哪了'],
  workDone: ['汪！搞定！', '收工啦～'],
  // Claude Code hook events
  ccStart: ['汪！开工！', '来活啦！'],
  ccPrompt: ['收到！汪', '我帮你盯着～'],
  ccWork: ['盯着呢…', '汪…在跑了', '（摇尾巴）'],
  ccDone: ['汪汪！好了！', '完成啦～快看！', '搞定！有奖励吗？'],
  ccAttention: ['汪！要你确认一下', '等你回复～汪', '这里要你拍板'],
};

export function pick(kind) {
  const arr = LINES[kind] || [];
  return arr[Math.floor(Math.random() * arr.length)] || '';
}

// A greeting that depends on the time of day, or null if nothing special.
export function timeGreeting(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 6 && h < 10) return '早上好！散步去不去？汪';
  if (h >= 11.5 && h < 13.5) return '饭点到了！汪汪！';
  if (h >= 17.5 && h < 19) return '傍晚了…晚饭吃什么？';
  if (h >= 0 && h < 5) return '太晚了…快睡觉吧，汪';
  return null;
}
