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

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
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
//
// Row identity comes from `data-row-key` — the official hook — not from an
// aria-label plus a geometry climb. The old guess matched the WORKSPACE row
// (its label is "工作区“…”的操作"), so this script silently tested nothing.
//
// Pick a row that HAS a menu trigger: an empty/new session row renders no action
// buttons at all (measured on the live sidebar: `新会话` → 0 buttons, a titled row
// → 3), so taking the first session row asserts against a row that cannot have a
// menu.
const rowRect = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-row-key^="session:"]')]
  const usable = rows.find((r) => r.querySelectorAll('button').length > 0) ?? rows[0]
  if (usable === undefined) return null
  const r = usable.getBoundingClientRect()
  // The TITLE alone, from a child element — never `row.textContent`, which
  // concatenates the relative-date badge (`…archive21天`). The trigger's label
  // names only the title (`会话“<title>”的操作`), so a concatenated string never
  // matches and the row reads as "no menu trigger".
  const firstChild = [...usable.children].map((child) => (child.textContent || '').trim()).find((text) => text.length > 0) ?? ''
  return {
    x: r.x, y: r.y, w: r.width, h: r.height,
    key: usable.getAttribute('data-row-key'),
    title: firstChild.slice(0, 60),
  }
})
console.log('[row]', JSON.stringify(rowRect))
if (rowRect !== null) {
  // OPEN the session first: reading a row's action cluster needs the ROW OPENED
  // and hovered — on an unopened (or unselected) row the cluster is not merely
  // invisible, it is not in the DOM at all, which is why a "buttons.length === 0"
  // measurement used to look like a broken fixture.
  await page.mouse.click(rowRect.x + 40, rowRect.y + rowRect.h / 2)
  await sleep(2500)
  // `page.hover` (not a bare mouse.move): the cluster is revealed by the row's
  // own CSS hover state, and a raw move does not always settle it in headless.
  await page.hover(`[data-row-key="${rowRect.key}"]`)
  await sleep(900)
  await snapshot('02-row-hover')
  // The trigger is identified by its OFFICIAL label prefix (`会话…的操作`) and
  // scoped by TITLE: the button is not reachable from the `data-row-key` element
  // by `querySelectorAll` (its rowActions span sits beside it), and with more
  // than one session row open, the first candidate is a real wrong answer.
  //
  // POLL for it: opening a session materialises its row and its action cluster on
  // the host round-trip, so a single probe can land before the cluster exists —
  // which then reads as "this row has no menu", the exact false negative this
  // script already suffered from once.
  const findTrigger = (title) => page.evaluate((needle) => {
    const candidates = [...document.querySelectorAll('button[aria-label]')]
      .filter((b) => (b.getAttribute('aria-label') || '').startsWith('会话'))
    const trigger = candidates.find((b) => needle.length > 0 && (b.getAttribute('aria-label') || '').includes(needle))
      ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (trigger === undefined) return null
    const r = trigger.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: trigger.getAttribute('aria-label'), candidates: candidates.length }
  }, title)

  let btnRect = null
  const deadline = Date.now() + 8000
  while (btnRect === null && Date.now() < deadline) {
    btnRect = await findTrigger(rowRect.title)
    if (btnRect === null) {
      // Re-hover each round: the cluster is revealed by the row's hover state, and
      // a re-render (the session opening) can drop it again.
      await page.hover(`[data-row-key="${rowRect.key}"]`).catch(() => {})
      await sleep(500)
    }
  }
  console.log('[ellipsis]', JSON.stringify(btnRect))
  if (btnRect !== null) {
    await page.mouse.click(btnRect.x, btnRect.y)
    await sleep(1200)
    await snapshot('03-session-menu')
    const menuItems = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim()))
    console.log('[menu] items:', JSON.stringify(menuItems))
    // SUBSTRING, not equality: dsh appends shortcut hints to these labels
    // (`归档会话` renders as `归档会话Ctrl+Alt+A`), so an exact match stopped
    // matching after an upstream change — with no error, just a missing row.
    const hasRedDelete = menuItems.some((item) => item.includes('彻底删除') || item.includes('Delete permanently'))
    console.log(`[menu] red delete item present: ${hasRedDelete}`)

    if (hasRedDelete) {
      const clicked = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')]
        const target = items.find((item) => item.textContent.includes('彻底删除') || item.textContent.includes('Delete permanently'))
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
