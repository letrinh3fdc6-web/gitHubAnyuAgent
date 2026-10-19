const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(pkg.dependencies?.qrcode === '1.5.4', '本机二维码依赖未锁定')
assert(main.includes("ipcMain.handle('payment:qr-data-url'"), '主进程未提供本机二维码接口')
assert(main.includes("ipcMain.handle('payment:open-browser'"), '主进程未提供支付页接口')
assert(main.includes('localStorage.removeItem'), '支付恢复快照未自动清理')
assert(preload.includes('paymentQrDataUrl'), '预加载层未暴露二维码接口')
assert(preload.includes('paymentOpenBrowser'), '预加载层未暴露支付页接口')
assert(renderer.includes("api('/payment/checkout-info')"), '未读取服务端充值配置')
assert(renderer.includes("api('/payment/orders'"), '未通过服务端创建充值订单')
assert(renderer.includes("order_type: 'balance'"), '充值订单类型不是余额充值')
assert(renderer.includes("/payment/orders/${encodeURIComponent(String(orderId))}"), '未轮询服务端订单状态')
assert(renderer.includes("['PAID', 'RECHARGING', 'COMPLETED']"), '未覆盖服务端成功状态')
assert(renderer.includes('state.rechargeQrDataUrl'), '未渲染本机二维码')

console.log('recharge contract tests passed')
