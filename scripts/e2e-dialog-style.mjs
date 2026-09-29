// Style-consistency check for the confirm dialog (diagnosis follow-up: the card
// used the translucent MENU surface and read as see-through). Opens the OFFICIAL
// rename dialog and the plugin's delete confirmation in the same page, then
// compares the computed card surface, radius, elevation and backdrop.
//
// Run: node scripts/e2e-dialog-style.mjs <url> [<screenshot-dir>]
import puppeteer from 'puppeteer-core'

const url = process.argv[2]
const shotDir = process.argv[3] ?? null
if (!url) process.exit(2)

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 200)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const rows = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key]')].map((el) => ({
  key: el.getAttribute('data-row-key'),
  text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 50),
  archived: /archived/i.test(el.className || ''),
  rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
})))

/** Card = the first non-mask layer that paints a background. The plugin dialog
 *  puts `role="dialog"` on its full-viewport mask layer, the official Modal puts
 *  it on the card itself, so mask layers are excluded by geometry. */
const cardStyleOf = (selector) => page.evaluate((sel) => {
  const root = document.querySelector(sel)
  if (root === null) return null
  const vw = window.innerWidth
  const vh = window.innerHeight
  const isMaskLayer = (el) => {
    const r = el.getBoundingClientRect()
    return r.width >= vw * 0.9 && r.height >= vh * 0.9
  }
  const card = [root, ...root.querySelectorAll('*')].find((el) => {
    if (isMaskLayer(el)) return false
    const bg = getComputedStyle(el).backgroundColor
    return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && el.getBoundingClientRect().width > 200
  })
  if (card === undefined) return null
  const cs = getComputedStyle(card)
  const title = card.querySelector('h1, h2, h3, [class*=title]')
  return {
    backgroundColor: cs.backgroundColor,
    borderRadius: cs.borderRadius,
    boxShadow: cs.boxShadow,
    width: Math.round(card.getBoundingClientRect().width),
    titleColor: title === null ? null : getComputedStyle(title).color,
    titleSize: title === null ? null : `${getComputedStyle(title).fontSize}/${getComputedStyle(title).lineHeight}`,
  }
}, selector)

/** Mask of a dialog: scan the dialog's outermost container for a full-viewport
 *  painted layer. The official Modal renders the mask as a SIBLING of the card
 *  (`Modal.module.css .mask::after`), so ancestors alone are not enough; the
 *  plugin paints it on its own root layer. */
const maskStyleOf = (selector) => page.evaluate((sel) => {
  const root = document.querySelector(sel)
  if (root === null) return null
  const vw = window.innerWidth
  const vh = window.innerHeight
  const transparent = 'rgba(0, 0, 0, 0)'
  const painted = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < vw * 0.9 || r.height < vh * 0.9) return null
    const cs = getComputedStyle(el)
    const after = getComputedStyle(el, '::after')
    const background = cs.backgroundColor !== transparent ? cs.backgroundColor : after.backgroundColor
    if (background === transparent) return null
    return {
      backgroundColor: background,
      backdropFilter: cs.backdropFilter !== 'none' ? cs.backdropFilter : after.backdropFilter,
    }
  }
  let scope = root
  while (scope.parentElement !== null && scope.parentElement !== document.body) scope = scope.parentElement
  for (const el of [scope, ...scope.querySelectorAll('*')]) {
    const style = painted(el)
    if (style !== null) return style
  }
  return null
}, selector)

const overlayStyleOf = (selector) => page.evaluate((sel) => {
  const root = document.querySelector(sel)
  if (root === null) return null
  const cs = getComputedStyle(root)
  return { backgroundColor: cs.backgroundColor, backdropFilter: cs.backdropFilter, padding: cs.padding }
}, selector)

const openMenu = async (rowKey) => {
  const row = (await rows()).find((entry) => entry.key === rowKey)
  if (row === undefined) return false
  await page.mouse.move(row.rect.x + row.rect.w / 2, row.rect.y + row.rect.h / 2)
  await sleep(800)
  const box = await page.evaluate((key) => {
    const el = document.querySelector(`[data-row-key="${key}"] button[aria-label^="会话"]`)
    if (el === null) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, rowKey)
  if (box === null) return false
  await page.mouse.click(box.x, box.y)
  await sleep(1000)
  return true
}

const clickMenuItem = (fragment) => page.evaluate((needle) => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => (el.textContent || '').includes(needle))
  if (item === undefined) return false
  item.click()
  return true
}, fragment)

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '继续')
  if (button !== undefined) button.click()
})
await sleep(1200)

// Prepare one openable session (restore an archived one when needed).
let target = (await rows()).find((row) => row.key.startsWith('session:') && !row.archived && !row.text.startsWith('新会话'))
if (target === undefined) {
  const restored = await page.evaluate(async () => {
    const post = async (endpoint, payload) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(`/api/session-manager/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: `session-manager/${endpoint}`, payload }),
      })
      return (await response.json()).result
    }
    const listed = await post('list', {})
    for (const item of (listed?.value?.items ?? []).filter((entry) => entry.blank !== true)) {
      const answer = await post('restore', { sessionId: item.sessionId })
      if (answer?.ok === true) return item.sessionId
    }
    return null
  })
  if (restored === null) throw new Error('no restorable session to open')
  await sleep(2500)
  target = (await rows()).find((row) => row.key === `session:${restored}`)
}
if (target === undefined) throw new Error('no session row available')
await page.mouse.click(target.rect.x + 40, target.rect.y + target.rect.h / 2)
await sleep(2500)

const report = {}

// 1) OFFICIAL dialog: the session rename modal (rendered by the product Modal).
if (!(await openMenu(target.key))) throw new Error('the row menu did not open')
if (!(await clickMenuItem('重命名'))) throw new Error('the rename item is missing')
await sleep(1500)
report.officialOverlay = await maskStyleOf('[role="dialog"]:not([data-sm-confirm])')
report.officialCard = await cardStyleOf('[role="dialog"]:not([data-sm-confirm])')
report.officialButtons = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]:not([data-sm-confirm]) button')].map((b) => {
  const cs = getComputedStyle(b)
  return { text: (b.textContent || '').trim().slice(0, 12), height: cs.height, borderRadius: cs.borderRadius }
}))
if (shotDir !== null) await page.screenshot({ path: `${shotDir}/dialog-official.png` })
await page.keyboard.press('Escape')
await sleep(900)

// 2) PLUGIN dialog: the red permanent-delete confirmation.
if (!(await openMenu(target.key))) throw new Error('the row menu did not reopen')
if (!(await clickMenuItem('彻底删除'))) throw new Error('the red delete item is missing')
await sleep(1500)
report.pluginOverlay = await overlayStyleOf('[data-sm-confirm]')
report.pluginCard = await cardStyleOf('[data-sm-confirm]')
report.pluginButtons = await page.evaluate(() => [...document.querySelectorAll('[data-sm-confirm] button')].map((b) => {
  const cs = getComputedStyle(b)
  return { text: (b.textContent || '').trim(), height: cs.height, borderRadius: cs.borderRadius, background: cs.backgroundColor, color: cs.color, border: cs.borderTopWidth }
}))
if (shotDir !== null) await page.screenshot({ path: `${shotDir}/dialog-plugin.png` })
await page.keyboard.press('Escape')
await sleep(600)
report.closedAfterEscape = (await page.$('[data-sm-confirm]')) === null

const alphaOf = (color) => {
  const match = /rgba?\(([^)]+)\)/.exec(color)
  if (match === null) return null
  const parts = match[1].split(',').map((value) => Number(value.trim()))
  return parts.length === 4 ? parts[3] : 1
}

const checks = []
const push = (name, pass, detail) => checks.push({ name, pass, detail })
push('plugin card is fully opaque', alphaOf(report.pluginCard?.backgroundColor ?? '') === 1, report.pluginCard?.backgroundColor)
push(
  'plugin card surface matches the official dialog surface',
  report.pluginCard?.backgroundColor === report.officialCard?.backgroundColor,
  `${report.pluginCard?.backgroundColor} vs ${report.officialCard?.backgroundColor}`,
)
push(
  'plugin card radius matches the official modal radius',
  report.pluginCard?.borderRadius === report.officialCard?.borderRadius,
  `${report.pluginCard?.borderRadius} vs ${report.officialCard?.borderRadius}`,
)
push(
  'plugin card elevation matches the official modal elevation',
  report.pluginCard?.boxShadow === report.officialCard?.boxShadow,
  `${report.pluginCard?.boxShadow} vs ${report.officialCard?.boxShadow}`,
)
push(
  'plugin backdrop uses the official mask colour',
  report.pluginOverlay?.backgroundColor === report.officialOverlay?.backgroundColor,
  `${report.pluginOverlay?.backgroundColor} vs ${report.officialOverlay?.backgroundColor}`,
)
push('escape closes the plugin dialog', report.closedAfterEscape === true, String(report.closedAfterEscape))
// The action buttons follow the official Button `md` spec (Button.module.css:
// height 36px, radius `--dsw-radius-md`), which is what RiskConfirmation uses —
// the plugin dialog is a risk confirmation, not a compact rename form.
push(
  'plugin actions use the official md control height (36px)',
  (report.pluginButtons ?? []).length > 0 && (report.pluginButtons ?? []).every((b) => b.height === '36px'),
  JSON.stringify((report.pluginButtons ?? []).map((b) => b.height)),
)
push(
  'plugin actions use the official control radius (12px)',
  (report.pluginButtons ?? []).length > 0 && (report.pluginButtons ?? []).every((b) => b.borderRadius === '12px'),
  JSON.stringify((report.pluginButtons ?? []).map((b) => b.borderRadius)),
)

await browser.close()
console.log(JSON.stringify({ report, checks }, null, 2))
for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}  (${check.detail})`)
const failed = checks.filter((check) => !check.pass)
if (failed.length > 0) throw new Error(`${failed.length} style check(s) failed`)
console.log('[done] dialog style matches the official modal')
