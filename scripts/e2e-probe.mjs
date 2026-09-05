// DOM probe: understand the live dsh web UI structure for the E2E script.
// Usage: node scripts/e2e-probe.mjs <authenticated-web-url>
import puppeteer from 'puppeteer-core'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/e2e-probe.mjs <authenticated-web-url>')
  process.exit(2)
}
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 200)))
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await new Promise((resolve) => setTimeout(resolve, 9000))

const report = await page.evaluate(() => {
  const out = {}
  out.boot = window.__DSH_BOOT__
  out.bootKeys = out.boot === undefined ? undefined : Object.keys(out.boot)
  out.hasOurModule = out.bootKeys !== undefined && out.bootKeys.some((k) => String(k).includes('session-manager'))
  out.bootEntries = out.boot === undefined ? undefined : (Array.isArray(out.boot) ? out.boot.length : typeof out.boot)

  // settings trigger: anything clickable whose text is exactly 设置 / Settings
  out.settingsTexts = [...document.querySelectorAll('*')]
    .filter((el) => el.children.length === 0 && /^(设置|Settings)$/.test((el.textContent || '').trim()))
    .map((el) => {
      let node = el
      const chain = []
      while (node && chain.length < 5) {
        chain.push({ tag: node.tagName, aria: node.getAttribute('aria-label'), role: node.getAttribute('role'), cls: String(node.className).slice(0, 60) })
        node = node.parentElement
      }
      return chain
    })

  // session action buttons + their rows
  out.sessionButtons = [...document.querySelectorAll('button[aria-label]')]
    .filter((b) => {
      const label = b.getAttribute('aria-label') || ''
      return (label.includes('的操作') || label.includes('Session actions'))
    })
    .map((b) => {
      const rect = b.getBoundingClientRect()
      let row = b.parentElement
      while (row && !(row.textContent || '').includes('1小时') && row.parentElement && row.tagName !== 'BODY') row = row.parentElement
      return {
        label: b.getAttribute('aria-label'),
        w: rect.width, h: rect.height, visible: b.offsetParent !== null,
        rowText: row === null ? '' : (row.textContent || '').slice(0, 80).replace(/\n/g, ' '),
        fiber: Object.keys(b).some((k) => k.startsWith('__reactFiber$')),
      }
    })

  // any element with role=menuitem right now
  out.menuItems = [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent.trim())

  // top bar buttons: dump aria-labels of all buttons visible at top 64px
  out.topButtons = [...document.querySelectorAll('button[aria-label], a[aria-label]')]
    .filter((el) => el.getBoundingClientRect().top < 70)
    .map((el) => ({ tag: el.tagName, aria: el.getAttribute('aria-label'), cls: String(el.className).slice(0, 40) }))
  return out
})
console.log(JSON.stringify(report, null, 2))
await browser.close()
