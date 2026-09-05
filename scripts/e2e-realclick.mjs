// Reproduce bug 1 with REAL mouse events: hover row -> click ellipsis ->
// move to the red menu item -> real click -> confirm dialog should appear.
// Also capture all console/page errors.
import { mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const url = process.argv[2]
const outDir = process.argv[3] || 'e2e-artifacts'
if (!url) {
  console.error('usage: node scripts/e2e-realclick.mjs <url> [outdir]')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', String(m.text()).slice(0, 300))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)

// find the session row rect
const rowRect = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
  const ellipsis = buttons.find((b) => {
    const label = b.getAttribute('aria-label') || ''
    return label.includes('的操作') && !label.includes('工作区')
  })
  if (!ellipsis) return null
  let node = ellipsis.parentElement
  while (node && node !== document.body) {
    const r = node.getBoundingClientRect()
    if (r.width > 120 && r.height > 20) return { x: r.x, y: r.y, w: r.width, h: r.height }
    node = node.parentElement
  }
  return null
})
console.log('[row]', JSON.stringify(rowRect))
if (rowRect === null) process.exit(1)

// real hover on the row
await page.mouse.move(rowRect.x + rowRect.w / 2, rowRect.y + rowRect.h / 2)
await sleep(800)
// real click on the ellipsis
const btn = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
  const ellipsis = buttons.find((b) => {
    const label = b.getAttribute('aria-label') || ''
    return label.includes('的操作') && !label.includes('工作区') && b.offsetParent !== null
  })
  if (!ellipsis) return null
  const r = ellipsis.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
if (btn === null) {
  console.log('[ellipsis] not visible')
  process.exit(1)
}
await page.mouse.click(btn.x, btn.y)
await sleep(1200)
await page.screenshot({ path: `${outDir}/r1-menu.png` })

// locate the red item rect
const redRect = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const red = items.find((i) => i.textContent.trim() === '彻底删除' || i.textContent.trim() === 'Delete permanently')
  if (!red) return null
  const r = red.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, text: red.textContent.trim() }
})
console.log('[red]', JSON.stringify(redRect))
if (redRect === null) {
  const items = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent.trim()))
  console.log('[menu items]', JSON.stringify(items))
  process.exit(1)
}

// real mouse: move onto the red item (crossing the popup boundary), then click
await page.mouse.move(redRect.x + redRect.w / 2, redRect.y + redRect.h / 2)
await sleep(600)
const stillThere = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const red = items.find((i) => i.textContent.trim() === '彻底删除' || i.textContent.trim() === 'Delete permanently')
  return red ? true : false
})
console.log('[red] still in DOM after hover:', stillThere)
await page.screenshot({ path: `${outDir}/r2-hover-red.png` })
await page.mouse.down()
await sleep(150)
await page.mouse.up()
await sleep(1000)
const overlayInfo = await page.evaluate(() => {
  const overlay = document.querySelector('[data-sm-confirm]')
  if (!overlay) return null
  return { text: overlay.textContent.replace(/\s+/g, ' ').slice(0, 200), rect: overlay.getBoundingClientRect().toJSON() }
})
console.log('[overlay]', JSON.stringify(overlayInfo))
await page.screenshot({ path: `${outDir}/r3-after-realclick.png` })

if (overlayInfo !== null) {
  // cancel via real click on the cancel button
  const cancelRect = await page.evaluate(() => {
    const overlay = document.querySelector('[data-sm-confirm]')
    const buttons = [...overlay.querySelectorAll('button')]
    const cancel = buttons.find((b) => /取消|Cancel/.test(b.textContent))
    if (!cancel) return null
    const r = cancel.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (cancelRect !== null) {
    await page.mouse.click(cancelRect.x, cancelRect.y)
    await sleep(500)
    const gone = await page.evaluate(() => document.querySelector('[data-sm-confirm]') === null)
    console.log('[overlay] dismissed after cancel:', gone)
  }
}
await browser.close()
console.log('[done]')
