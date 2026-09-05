// E2E browser check for dsh-session-manager against a locally booted dsh web
// instance. Read-only: it never confirms a restore/delete — the deepest
// interaction is opening the confirm dialog and cancelling it.
//
// Usage:
//   node scripts/e2e-check.mjs <authenticated-web-url> [--out <dir>]
import { mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const url = process.argv[2]
const outArgIndex = process.argv.indexOf('--out')
const outDir = outArgIndex === -1 ? 'e2e-artifacts' : process.argv[outArgIndex + 1]
if (!url) {
  console.error('usage: node scripts/e2e-check.mjs <authenticated-web-url> [--out <dir>]')
  process.exit(2)
}

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
await mkdir(outDir, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (error) => {
  pageErrors.push(String(error).slice(0, 300))
  console.log('[pageerror]', String(error).slice(0, 300))
})
page.on('console', (message) => {
  if (message.type() === 'error') console.log('[console.error]', String(message.text()).slice(0, 200))
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function snapshot(name) {
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false })
  console.log(`[shot] ${outDir}/${name}.png`)
}

console.log(`[goto] ${url.slice(0, 80)}...`)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)

// ── 0. our client module must be in the boot roster ─────────────────────────
const roster = await page.evaluate(() => {
  const boot = window.__DSH_BOOT__
  const entries = boot && Array.isArray(boot.entries) ? boot.entries : []
  return { has: entries.some((e) => String(e.id).includes('session-manager')), total: entries.length }
})
console.log(`[roster] our client module present: ${roster.has} (${roster.total} entries)`)
await snapshot('01-boot')

// ── 1. three-dot menu via real mouse (CSS reveals row actions on hover) ────
const rowRect = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
  const ellipsis = buttons.find((b) => {
    const label = b.getAttribute('aria-label') || ''
    return label.includes('的操作') && !label.includes('工作区')
  })
  if (!ellipsis) return null
  // climb from the ellipsis button to the wide session-row element
  let node = ellipsis.parentElement
  let row = null
  while (node && node !== document.body) {
    const r = node.getBoundingClientRect()
    if (r.width > 120 && r.height > 20) { row = node; break }
    node = node.parentElement
  }
  if (!row) return null
  const r = row.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, hasFiber: Object.keys(ellipsis).some((k) => k.startsWith('__reactFiber$')) }
})
console.log('[row]', JSON.stringify(rowRect))
if (rowRect !== null) {
  const cx = rowRect.x + rowRect.w / 2
  const cy = rowRect.y + rowRect.h / 2
  await page.mouse.move(cx, cy)
  await sleep(700)
  await snapshot('02-row-hover')
  // find the now-visible ellipsis button and click it with the real mouse
  const btnRect = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label]')]
    const ellipsis = buttons.find((b) => {
      const label = b.getAttribute('aria-label') || ''
      return label.includes('的操作') && !label.includes('工作区') && b.offsetParent !== null
    })
    if (!ellipsis) return null
    const r = ellipsis.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  console.log('[ellipsis]', JSON.stringify(btnRect))
  if (btnRect !== null) {
    await page.mouse.click(btnRect.x, btnRect.y)
    await sleep(1200)
    await snapshot('03-session-menu')
    const menuItems = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim()))
    console.log('[menu] items:', JSON.stringify(menuItems))
    const hasRedDelete = menuItems.some((item) => item === '彻底删除' || item === 'Delete permanently')
    console.log(`[menu] red delete item present: ${hasRedDelete}`)

    if (hasRedDelete) {
      const clicked = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')]
        const target = items.find((item) => item.textContent.trim() === '彻底删除' || item.textContent.trim() === 'Delete permanently')
        if (!target) return false
        target.click()
        return true
      })
      console.log(`[menu] clicked red delete item: ${clicked}`)
      await sleep(900)
      await snapshot('04-delete-confirm')
      const confirmText = await page.evaluate(() => {
        const overlay = document.querySelector('[data-sm-confirm]')
        return overlay ? overlay.textContent.replace(/\s+/g, ' ').slice(0, 300) : '(no confirm overlay)'
      })
      console.log('[confirm]', confirmText)
      const cancelled = await page.evaluate(() => {
        const overlay = document.querySelector('[data-sm-confirm]')
        if (!overlay) return false
        const buttons = [...overlay.querySelectorAll('button')]
        const cancel = buttons.find((b) => /取消|Cancel/.test(b.textContent))
        if (!cancel) return false
        cancel.click()
        return true
      })
      console.log(`[confirm] cancelled: ${cancelled}`)
      await sleep(500)
    }
  }
}

// ── 2. settings → 会话管理 section ──────────────────────────────────────────
const gearClicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /^(设置|Settings)$/.test((b.textContent || '').trim()))
  if (!button) return false
  button.click()
  return true
})
console.log(`[settings] gear clicked: ${gearClicked}`)
await sleep(2500)

const sectionClicked = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('button, span, div, a')]
  const hit = nodes.find((node) => node.children.length === 0 && /^(会话管理|Session Manager)$/.test((node.textContent || '').trim()))
  if (!hit) return false
  ;(hit.closest('button') || hit).click()
  return true
})
console.log(`[settings] section clicked: ${sectionClicked}`)
await sleep(2500)
await snapshot('05-settings-section')

const sectionFacts = await page.evaluate(() => {
  const text = document.body.innerText
  return {
    hasArchiveHeader: text.includes('已归档会话') || text.includes('Archived sessions'),
    hasRestore: text.includes('恢复') || text.includes('Restore'),
    hasDelete: text.includes('彻底删除') || text.includes('Delete permanently'),
    hasGreetingTitle: text.includes('Greeting'),
    showsUnknownSession: text.includes('会话不存在') || text.includes('session missing'),
  }
})
console.log('[section]', JSON.stringify(sectionFacts))
await sleep(300)
await snapshot('06-settings-section-bottom')

await browser.close()
console.log('[pageerrors]', pageErrors.length)
console.log('[done]')
