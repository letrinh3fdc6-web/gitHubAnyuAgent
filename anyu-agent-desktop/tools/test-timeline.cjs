const fs = require('fs')
const vm = require('vm')
const source = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8')
const start = source.indexOf('  function orderTimeline(')
const end = source.indexOf('  async function refreshMessages(')
if (start < 0 || end < 0) throw new Error('timeline functions not found')
const context = {}
vm.runInNewContext(`const state = { mediaActivity: {} }; ${source.slice(start, end)}; this.orderTimeline = orderTimeline; this.timelineMessagesUnique = timelineMessagesUnique; this.beginMediaActivity = beginMediaActivity; this.moveMediaActivity = moveMediaActivity; this.endMediaActivity = endMediaActivity; this.mediaActivityForSession = mediaActivityForSession;`, context)
const actual = context.orderTimeline([
  { id: 'hello-assistant', role: 'assistant', createdAt: 3000 },
  { id: 'image-result', role: 'assistant', createdAt: 2000.5 },
  { id: 'image-request', role: 'user', createdAt: 2000 },
  { id: 'hello-request', role: 'user', createdAt: 3000 }
]).map((message) => message.id)
const expected = ['image-request', 'image-result', 'hello-assistant', 'hello-request']
if (actual.join(',') !== expected.join(',')) throw new Error(`timeline order expected ${expected.join(',')}, got ${actual.join(',')}`)
console.log('timeline ordering: passed')
const mediaTask = { id: 'task-video-1', role: 'user', content: '@生视频 让小狗动起来', createdAt: 2000 }
const restoredMediaTask = { role: 'user', content: mediaTask.content, createdAt: 2000 }
const unique = context.timelineMessagesUnique([mediaTask, restoredMediaTask])
if (unique.length !== 1 || unique[0].id !== mediaTask.id) throw new Error('media task de-duplication failed')
console.log('media task de-duplication: passed')
context.beginMediaActivity('session-a', 'task-video-1', 'video')
context.beginMediaActivity('session-a', 'task-image-1', 'image')
context.moveMediaActivity('session-a', 'session-b', 'task-video-1')
if (context.mediaActivityForSession('session-a').length !== 1 || context.mediaActivityForSession('session-b').length !== 1) throw new Error('media activity session isolation failed')
context.endMediaActivity('session-b', 'task-video-1')
if (context.mediaActivityForSession('session-b').length !== 0) throw new Error('media activity cleanup failed')
console.log('media activity session isolation: passed')
