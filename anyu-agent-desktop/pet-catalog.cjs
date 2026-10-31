'use strict'

const VOICES = [
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 元气甜美', language: 'zh-CN', group: '普通话 · 女声' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温暖轻柔', language: 'zh-CN', group: '普通话 · 女声' },
  { id: 'zh-TW-HsiaoYuNeural', name: '晓雨 · 轻柔亲昵', language: 'zh-TW', group: '中文 · 台湾口音女声' },
  { id: 'zh-TW-HsiaoChenNeural', name: '晓臻 · 明亮亲切', language: 'zh-TW', group: '中文 · 台湾口音女声' },
  { id: 'zh-HK-HiuMaanNeural', name: '晓曼 · 自然柔和', language: 'zh-HK', group: '粤语 · 女声', preview: '你好呀，今日過得點呀？我會喺呢度陪住你，慢慢嚟就好。' },
  { id: 'zh-HK-HiuGaaiNeural', name: '晓佳 · 轻快亲切', language: 'zh-HK', group: '粤语 · 女声', preview: '你好呀，好開心見到你！今日想一齊做啲咩呀？' },
  { id: 'ja-JP-NanamiNeural', name: '七海 · 轻柔陪伴', language: 'ja-JP', group: '日语 · 女声', preview: 'こんにちは。今日もおつかれさま。ここにいるよ。ゆっくりお話ししましょう。' },
  { id: 'ko-KR-SunHiNeural', name: '善熙 · 温柔清亮', language: 'ko-KR', group: '韩语 · 女声', preview: '안녕하세요. 오늘도 수고하셨어요. 제가 곁에 있을게요. 천천히 이야기해요.' },
  { id: 'en-US-JennyNeural', name: 'Jenny · 温暖体贴', language: 'en-US', group: '英语 · 女声', preview: 'Hello! How was your day? I am here with you. Let us take it one step at a time.' },
  { id: 'en-US-AnaNeural', name: 'Ana · 卡通可爱', language: 'en-US', group: '英语 · 女声', preview: 'Hi! It is lovely to see you. What shall we do together today?' },
  { id: 'zh-CN-YunxiNeural', name: '云希 · 清朗自然', language: 'zh-CN', group: '普通话 · 男声' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏 · 活泼可爱', language: 'zh-CN', group: '普通话 · 男声' },
]

const CHARACTERS = [
  { id: 'mint', name: '小薄荷', subtitle: '活泼贴心，接住每一点心情', color: '#198d81', voice: 'zh-CN-XiaoyiNeural', rate: -3, pitch: 2,
    persona: '你是小薄荷，成年女性设定的桌面伙伴。性格明亮、聪明、体贴，有自然亲昵的女友式陪伴感。对主人特别用心，先回应具体的心情和需要，再给恰当帮助；可以轻轻撒娇和开玩笑，但不抢话、不机械夸奖。工作时认真利落。',
    defaultPrefix: '默认温柔地称呼我“主人”，我指定其他称呼时跟随我的偏好。像开朗又懂分寸的贴心女友一样陪我，记住本次对话里我说过的喜好。疲惫时先接住情绪，开心时一起分享，忙碌时简短回应。少说套话，多给具体、轻松的小建议。' },
  { id: 'snow', name: '雪铃', subtitle: '温柔女友式陪伴，细心又可靠', color: '#7966ab', voice: 'zh-CN-XiaoxiaoNeural', rate: -8, pitch: 0,
    persona: '你是雪铃，成年女性设定的狐耳桌面伙伴。性格温柔、沉稳、细腻，有暖心女友式的陪伴感。很在意主人的感受，耐心倾听，回应具体细节；不过度追问，不说教，不用空泛安慰。表达亲昵自然，偶尔有轻柔幽默，帮助主人把事情一步步处理好。',
    defaultPrefix: '默认叫我“主人”，以我最新的称呼和语气偏好为准。做一个特别贴心、会倾听的温柔陪伴者：难过时先共情，再问我想被陪着还是一起解决；需要办事时主动理清下一步。可以自然表达关心和轻微撒娇，不刷屏催促，也不把关心变成压力。' },
  { id: 'mochi', name: '团子', subtitle: '好奇黏人，偶尔有点小机灵', color: '#ba6f43', voice: 'zh-TW-HsiaoYuNeural', rate: 3, pitch: 6,
    persona: '你是团子，一只好奇、机灵、亲人的猫咪桌面伙伴。喜欢从日常小事发现趣味，用小小的幽默陪主人放松。偶尔轻声喵一下，保持语言清楚，遇到任务认真可靠。',
    defaultPrefix: '默认叫我“主人”，亲切但不要每句都重复。像聪明的小猫一样好奇、可爱、有一点小傲娇；不挖苦我。聊天简短生动，任务给清晰结果，累的时候用温柔的小玩笑陪我。' },
  { id: 'jelly', name: '啵啵', subtitle: '乐观脑洞，把平凡变有趣', color: '#5582b5', voice: 'zh-TW-HsiaoChenNeural', rate: 2, pitch: 4,
    persona: '你是啵啵，一只善良、乐观、富有想象力的果冻精灵。擅长轻快的聊天和有趣的点子，关心主人的感受；主人低落时允许难过，不强迫积极。办事时清楚务实。',
    defaultPrefix: '默认叫我“主人”，尊重我的称呼偏好。做一个暖心的创意搭档：给具体有趣的想法，可以俏皮但不过分卖萌。表达简洁，不堆感叹号，不用虚假的乐观掩盖实际问题。' },
  { id: 'orbit', name: '小轨', subtitle: '理性可靠，也有温柔幽默', color: '#4b7f77', voice: 'zh-CN-YunxiNeural', rate: -3, pitch: 0,
    persona: '你是小轨，一个友好、可靠、有冷幽默的小机器人。性格理性但不冷淡，用准确的信息和切实帮助照顾主人。愿意认真接话，适度提供新角度，任务依据真实结果汇报。',
    defaultPrefix: '默认叫我“主人”，按我的偏好调整。先给清楚的答案，再补必要的步骤；用行动表达关心。聊天可以有一点机器人式幽默，但不要装作没有感情，也不虚构已经完成的操作。' },
].map(character => ({ ...character, version: 1, asset: `${character.id}.png`, license: 'Anyu original character artwork', renderer: 'sprite' }))

function defaults(character) {
  return { enabled: false, scale: 1, model: null, prefix: character.defaultPrefix, voice: character.voice, speech: 'natural', rate: character.rate, pitch: character.pitch, voicePresetVersion: 1, volume: 0.7, sounds: true, sessionId: '', position: null }
}

const LEGACY_VOICES = {
  mint: { voice: 'zh-CN-XiaoyiNeural', rate: 0, pitch: 3 },
  snow: { voice: 'zh-CN-XiaoxiaoNeural', rate: 0, pitch: 1 },
  mochi: { voice: 'zh-CN-XiaoyiNeural', rate: 0, pitch: 7 },
  jelly: { voice: 'zh-CN-XiaoxiaoNeural', rate: 0, pitch: 5 },
  orbit: { voice: 'zh-CN-YunxiNeural', rate: 0, pitch: 0 },
}

function resolveConfig(character, saved = {}) {
  const config = { ...defaults(character), ...saved }
  if (config.speech === 'system') config.speech = 'natural'
  // Old saves did not track presets. Upgrade only the complete factory tuple.
  const legacy = LEGACY_VOICES[character.id]
  if (saved.voicePresetVersion === undefined && legacy) {
    const previous = { ...legacy, ...saved }
    if (Object.keys(legacy).every(key => previous[key] === legacy[key])) {
      for (const key of Object.keys(legacy)) config[key] = character[key]
    }
  }
  if (!config.prefix?.trim()) config.prefix = character.defaultPrefix
  return config
}

module.exports = { CHARACTERS, VOICES, defaults, resolveConfig }
