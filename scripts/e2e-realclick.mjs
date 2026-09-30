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
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
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

// find the session row through the official `data-row-key` hook: the old
// aria-label + geometry climb matched the WORKSPACE row (whose label is
// "工作区“…”的操作"), so this script never reached its own assertions.
//
// Pick a row that HAS a menu trigger — an empty/new session row renders none
// (measured: `新会话` → 0 buttons, a titled row → 3).
const rowRect = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-row-key^="session:"]')]
  const usable = rows.find((r) => r.querySelectorAll('button').length > 0) ?? rows[0]
  if (usable === undefined) return null
  const r = usable.getBoundingClientRect()
  // The TITLE alone, from a child element — never `row.textContent`, which
  // concatenates the relative-date badge (`…archive21天`) and therefore never
  // matches the trigger's `会话“<title>”的操作` label.
  const firstChild = [...usable.children].map((child) => (child.textContent || '').trim()).find((text) => text.length > 0) ?? ''
  return {
    x: r.x, y: r.y, w: r.width, h: r.height,
    key: usable.getAttribute('data-row-key'),
    title: firstChild.slice(0, 60),
  }
})
console.log('[row]', JSON.stringify(rowRect))
if (rowRect === null) process.exit(1)

// OPEN the session first: a row's action cluster is not in the DOM until the row
// is both opened and hovered, so probing it on a fresh row reports "no trigger"
// and looks like a fixture failure.
await page.mouse.click(rowRect.x + 40, rowRect.y + rowRect.h / 2)
await sleep(2500)
// real hover on the row (`page.hover`, so the row's CSS hover state settles)
await page.hover(`[data-row-key="${rowRect.key}"]`)
await sleep(900)
// real click on the row's own menu trigger, picked by the official
// `会话“<title>”的操作` label — the button is not reachable from the row element.
// POLL for it: opening a session materialises the row and its action cluster on
// the host round-trip, so one probe can land too early and read as "no menu".
const findTrigger = (title) => page.evaluate((needle) => {
  const candidates = [...document.querySelectorAll('button[aria-label]')]
    .filter((b) => (b.getAttribute('aria-label') || '').startsWith('会话'))
  const trigger = candidates.find((b) => needle.length > 0 && (b.getAttribute('aria-label') || '').includes(needle))
    ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (trigger === undefined) return null
  const r = trigger.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}, title)
let btn = null
const deadline = Date.now() + 8000
while (btn === null && Date.now() < deadline) {
  btn = await findTrigger(rowRect.title)
  if (btn === null) {
    await page.hover(`[data-row-key="${rowRect.key}"]`).catch(() => {})
    await sleep(500)
  }
}
if (btn === null) {
  console.log('[ellipsis] not visible')
  process.exit(1)
}
await page.mouse.click(btn.x, btn.y)
await sleep(1200)
await page.screenshot({ path: `${outDir}/r1-menu.png` })

// locate the red item rect. SUBSTRING matching: dsh appends shortcut hints to
// menu labels, so `=== '彻底删除'` stopped matching — and this lookup is an
// exit(1) path, which made a fixture failure look like a caught regression.
const redRect = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const red = items.find((i) => /彻底删除|Delete permanently/.test(i.textContent || ''))
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
  return items.some((i) => /彻底删除|Delete permanently/.test(i.textContent || ''))
})
console.log('[red] still in DOM after hover:', stillThere)
// bug 1: the row used to disappear when the pointer entered the popup. That is a
// REGRESSION, so it must fail the run — a console line nobody reads is not a test.
if (stillThere !== true) {
  console.error('FAIL: the red delete item vanished when the mouse entered the menu (bug 1 reproduced)')
  await page.screenshot({ path: `${outDir}/r2-hover-red.png` })
  await browser.close()
  process.exit(1)
}
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

// bug 1's other half: a real click on the row must open the confirm dialog. This
// used to be logged and skipped, so the script exited 0 exactly when the feature
// was broken.
if (overlayInfo === null) {
  console.error('FAIL: a real click on the red delete item opened no confirm dialog (bug 1 reproduced)')
  await browser.close()
  process.exit(1)
}

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
