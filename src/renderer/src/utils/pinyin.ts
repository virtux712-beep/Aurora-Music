/**
 * Pinyin initials for local-library search.
 *
 * Why a table and not a dictionary: a full pinyin engine is a multi-megabyte data dependency, while
 * the local search only ever needs *initials* — "aqhy" should find 「爱 情 回 忆」, and that is one
 * lookup per character. So this ships a curated table of the characters that actually show up in
 * Chinese song titles, artists, albums and file names.
 *
 * Behaviour that matters:
 *  - characters outside the table simply contribute nothing (the search falls back to the other
 *    fields), so **coverage never produces a wrong match** — only a missed shortcut;
 *  - non-Chinese input is lower-cased and kept as-is, so "jay" and "JAY" behave the same;
 *  - `initials()` is also used to index the file name, which is why unknown characters are skipped
 *    rather than replaced with a placeholder.
 */

/** Characters grouped by the first letter of their pinyin. Readable on purpose: it is hand-checked. */
const GROUPS: Record<string, string> = {
  a: '阿啊哎唉爱矮安按暗昂奥',
  b: '八巴吧拔白百败班般半伴帮包宝保抱报暴杯悲北贝备背被本鼻比彼笔币必毕闭碧壁避边变便遍标表别宾冰兵并波播博薄补捕不布步部',
  c: '才材财采彩菜参餐残灿仓苍沧藏操草册侧策层曾插察差拆柴产长尝常场畅唱抄超朝潮车彻沉陈晨衬称成城乘程橙池迟持赤充冲虫崇抽仇愁筹丑初出除厨楚处触川穿传船串窗床创吹春纯唇词慈此从丛凑粗促村存寸错',
  d: '搭达答打大呆代带待袋单担丹但淡当党刀导岛到倒道得的灯等低滴敌底地第弟帝递点电店殿调掉跌叠丁顶订定丢东冬懂动都斗豆督独读堵度渡端短段断堆队对多朵躲',
  e: '儿而耳二饿恩',
  f: '发法帆番翻凡烦繁反返饭范方防房放飞非肥废费分组份丰风封疯峰锋冯缝凤佛否夫扶服浮符福父付负妇附复副富覆',
  g: '该改概干甘刚钢岗高搞告哥歌格隔个各给根跟更工公功攻供宫恭共贡勾沟构够估姑孤古骨谷股故顾瓜刮挂怪关观官冠馆管惯光广归规轨鬼贵桂滚国果过',
  h: '哈孩海害含寒喊汉汗行好号毫喝合何和河荷花华画话怀坏欢还环缓换幻荒慌皇黄灰回悔会汇绘惠昏婚混活火伙或货获',
  j: '击机鸡积基绩激及吉级极即急集几己挤计记纪技济际既继寄加夹家佳嘉价架假嫁尖坚间肩艰监兼减简见件建剑健江将讲奖降交娇骄焦角脚叫教接阶街节结姐解介借今金津仅尽进近劲京经惊精井景警净竟竟境静九久酒旧居局举巨句拒具剧据距聚卷决绝军均君',
  k: '卡开看康抗考靠科棵颗壳可克刻客课肯空孔恐控口扣哭苦库裤跨块快宽款狂况亏昆困扩',
  l: '拉啦来兰拦蓝览烂郎浪劳老乐雷泪类冷离梨黎礼李里理力厉立丽利例连莲联脸练炼恋良凉两亮量疗了料列烈猎林临淋灵铃零领令另留流六龙笼楼露旅绿乱略伦轮论罗落',
  m: '妈麻马吗买卖满慢忙猫毛冒貌么没玫眉梅媒每美妹门闷们梦迷米密棉免面苗描妙灭民敏名明鸣命摸模摩磨魔抹末莫墨某母木目牧幕慕',
  n: '拿哪那纳乃奶男南难囊脑闹呢内嫩能你尼泥年念娘鸟您宁牛农弄努怒女暖挪诺',
  o: '哦欧偶',
  p: '爬怕拍排牌派盘判盼旁胖抛跑泡陪培赔佩配喷朋棚蓬碰批披皮疲匹片偏骗飘漂票品平评苹凭瓶坡泼婆迫破铺普',
  q: '七妻期其奇骑棋齐旗起气汽弃泣恰千迁牵前钱潜浅遣强墙抢敲桥巧切且亲侵秦琴勤青轻倾清情晴请庆丘秋求球区曲取去全权泉劝缺却确群',
  r: '然燃染让绕热人仁认任日荣容柔如入软瑞润若弱',
  s: '撒洒塞赛三散桑扫色森杀沙晒山善伤商上少绍蛇舍设社身深神甚生声胜圣盛失诗施湿十石时识实拾食史始士氏世市事势试视是适收手守首受瘦书叔舒疏输熟术树数双霜谁水睡顺说司丝思斯死四寺似松送宋搜苏俗诉素速算虽随岁孙损所索锁',
  t: '他她它踏台太态谈弹坦叹探堂唐塘糖涛逃陶讨套特疼腾梯提题体天田甜填挑条跳贴铁听亭庭停挺通同童统头投透突图途土吐兔团推腿退吞托拖脱',
  w: '挖娃外弯完玩顽晚万王网往忘危威微为围唯维伟未位味胃谓温文闻问翁我握乌污屋无五午武舞务物误悟雾',
  x: '西吸希昔析息稀溪席习洗喜戏系细下夏仙先纤鲜闲现线县限相香乡想向项象像消萧销小孝校笑些协邪写谢心辛欣新信星兴行形醒杏幸性兄凶胸雄休修秀绣需徐许序叙绪续宣悬选学雪寻询迅',
  y: '压呀鸦牙芽亚烟延严言岩沿研颜眼演宴雁央扬羊阳杨洋仰样妖腰邀摇遥药要爷也业叶页夜一衣医依伊仪宜已以乙义艺忆议异役易意溢因音阴银引饮隐印应英樱迎盈营影硬拥永勇涌用优忧幽悠尤由犹游友有又右幼于余鱼娱渔愉与宇羽雨语育玉芋郁遇预欲元员园原圆援源远愿约月越云允运韵',
  z: '杂灾再在咱咱赞脏早枣造则责怎增赠扎眨炸摘窄粘展占战站张章长掌丈招昭找照折哲者这贞针珍真振震争征挣整正证郑支只知织执直职止纸至志制治致秩中忠终钟种众舟周洲珠竹主住助注祝专转庄装状追准桌资子紫字自宗总走租足族祖组钻最罪尊作昨左做座',
}

const INITIAL_BY_CHAR = (() => {
  const map = new Map<string, string>()
  for (const [initial, characters] of Object.entries(GROUPS)) {
    for (const character of characters) map.set(character, initial)
  }
  return map
})()

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/** First letter of one character's pinyin, or `''` when the character is not in the table. */
export function pinyinInitial(character: string): string {
  return INITIAL_BY_CHAR.get(character) ?? ''
}

/**
 * The initials of a whole string, e.g. 「周杰伦」 → `zjl`.
 *
 * Latin letters and digits are kept so mixed strings still work ("jay 周杰伦" → `jayzjl`), and
 * everything else (spaces, punctuation, emoji) is dropped.
 */
export function initials(value: string): string {
  const lower = value.toLowerCase()
  let result = ''
  for (const character of lower) {
    if (INITIAL_BY_CHAR.has(character)) {
      result += INITIAL_BY_CHAR.get(character)
      continue
    }
    if (/[a-z0-9]/.test(character)) result += character
  }
  return result
}

/**
 * True when `query` looks like someone typing initials rather than a word: ASCII only, and short
 * enough that it cannot be a title on its own. Used to decide whether initials are worth computing.
 */
export function looksLikeInitials(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0 || trimmed.length > 12) return false
  return /^[a-z0-9]+$/i.test(trimmed)
}

/** Convenience for callers that already have the haystack parts. */
export function matchesInitials(parts: string[], query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!looksLikeInitials(needle)) return false
  return parts.some((part) => {
    if (!part) return false
    // Any run of Chinese characters is tried on its own so the initials of an artist name are not
    // buried behind the title's initials ("周杰伦 晴天" must still answer to `zjl`).
    if (initials(part).includes(needle)) return true
    return CJK.test(part) && initials(part.replace(/[^\u3400-\u9fff\uf900-\ufaff]+/g, '')).includes(needle)
  })
}
