// E2E mutation loop for dsh-session-manager in the ISOLATED test home:
//   settings: restore "Greeting" -> workspace menu: archive it again
//   -> settings: delete it (direct physical delete, no backup layer).
//   Also verifies the red menu item's computed
//   color. Run only against a disposable DSH_HOME.
//
// Usage: node scripts/e2e-mutations.mjs <authenticated-web-url> <e2e-home-win-path> [--out <dir>]
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const url = process.argv[2]
const e2eHome = process.argv[3]
const outArgIndex = process.argv.indexOf('--out')
const outDir = outArgIndex === -1 ? 'e2e-artifacts' : process.argv[outArgIndex + 1]
if (!url || !e2eHome) {
  console.error('usage: node scripts/e2e-mutations.mjs <url> <e2e-home-win-path> [--out <dir>]')
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
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shot = async (name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` })
  console.log(`[shot] ${outDir}/${name}.png`)
}
const bodyHas = (text) => page.evaluate((t) => document.body.innerText.includes(t), text)

async function openSettings() {
  const ok = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) => /^(设置|Settings)$/.test((b.textContent || '').trim()))
    if (!button) return false
    button.click()
    return true
  })
  await sleep(2200)
  return ok
}
async function openSection() {
  const ok = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, span, div, a')]
    const hit = nodes.find((node) => node.children.length === 0 && /^(会话管理|Session Manager)$/.test((node.textContent || '').trim()))
    if (!hit) return false
    ;(hit.closest('button') || hit).click()
    return true
  })
  await sleep(2000)
  return ok
}
async function closeSettings() {
  await page.keyboard.press('Escape')
  await sleep(1500)
}

console.log(`[goto] ${url.slice(0, 70)}...`)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)
await shot('m01-boot')

// ── 1. red menu item computed style ─────────────────────────────────────────
const rowRect = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
  const ellipsis = buttons.find((b) => {
    const label = b.getAttribute('aria-label') || ''
    return label.includes('的操作') && !label.includes('工作区')
  })
  let node = ellipsis.parentElement
  while (node && node !== document.body) {
    const r = node.getBoundingClientRect()
    if (r.width > 120 && r.height > 20) return { x: r.x, y: r.y, w: r.width, h: r.height }
    node = node.parentElement
  }
  return null
})
if (rowRect !== null) {
  await page.mouse.move(rowRect.x + rowRect.w / 2, rowRect.y + rowRect.h / 2)
  await sleep(700)
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
  if (btn !== null) {
    await page.mouse.click(btn.x, btn.y)
    await sleep(1100)
    const style = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')]
      const red = items.find((i) => i.textContent.trim() === '彻底删除' || i.textContent.trim() === 'Delete permanently')
      if (!red) return null
      const cs = getComputedStyle(red)
      return { color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize }
    })
    console.log('[style] red item computed:', JSON.stringify(style))
    await shot('m02-red-menu-item')
    await page.keyboard.press('Escape')
    await sleep(600)
  }
}

// ── 2. restore "Greeting" from the settings page ────────────────────────────
await openSettings()
await openSection()
console.log('[t0] settings has Greeting:', await bodyHas('Greeting'))
const restoreClicked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('div')]
  const row = rows.find((d) => d.textContent.includes('Greeting') && d.querySelectorAll('button').length >= 2 && d.offsetParent !== null && d.getBoundingClientRect().width > 300)
  if (!row) return false
  const button = [...row.querySelectorAll('button')].find((b) => /^(恢复|Restore)$/.test((b.textContent || '').trim()))
  if (!button) return false
  button.click()
  return true
})
console.log('[restore] clicked:', restoreClicked)
await sleep(2200)
console.log('[t1] settings still shows Greeting:', await bodyHas('Greeting'))
await shot('m03-after-restore')
await closeSettings()
// Greeting should now be back in the workspace browser
console.log('[t2] browser shows Greeting row:', await bodyHas('Greeting'))

// ── 3. archive it again through the OFFICIAL menu ───────────────────────────
const reArchived = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
  const ellipsis = buttons.find((b) => {
    const label = b.getAttribute('aria-label') || ''
    return label.includes('Greeting') || label.includes('的操作')
  })
  return ellipsis ? true : false
})
console.log('[archive] Greeting row ellipsis found:', reArchived)
if (reArchived) {
  const gRect = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label]')]
    const ellipsis = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('Greeting'))
    if (!ellipsis) return null
    let node = ellipsis.parentElement
    while (node && node !== document.body) {
      const r = node.getBoundingClientRect()
      if (r.width > 120 && r.height > 20) return { x: r.x, y: r.y, w: r.width, h: r.height }
      node = node.parentElement
    }
    return null
  })
  if (gRect !== null) {
    await page.mouse.move(gRect.x + gRect.w / 2, gRect.y + gRect.h / 2)
    await sleep(700)
    const gBtn = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button[aria-label]')]
      const ellipsis = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('Greeting') && b.offsetParent !== null)
      if (!ellipsis) return null
      const r = ellipsis.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    if (gBtn !== null) {
      await page.mouse.click(gBtn.x, gBtn.y)
      await sleep(1100)
      const clickedArchive = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')]
        const archive = items.find((i) => i.textContent.trim() === '归档会话' || i.textContent.trim() === 'Archive session')
        if (!archive) return false
        archive.click()
        return true
      })
      console.log('[archive] official archive item clicked:', clickedArchive)
      await sleep(2000)
      console.log('[t3] browser still shows Greeting row:', await bodyHas('Greeting'))
    }
  }
}

// ── 4. delete "Greeting" from the settings page ───────────────────────────
await openSettings()
await openSection()
const deleteClicked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('div')]
  const row = rows.find((d) => d.textContent.includes('Greeting') && d.querySelectorAll('button').length >= 2 && d.offsetParent !== null && d.getBoundingClientRect().width > 300)
  if (!row) return false
  const button = [...row.querySelectorAll('button')].find((b) => /^(彻底删除|Delete permanently)$/.test((b.textContent || '').trim()))
  if (!button) return false
  button.click()
  return true
})
console.log('[delete] settings delete clicked:', deleteClicked)
await sleep(900)
await shot('m04-delete-confirm')
const confirmDone = await page.evaluate(() => {
  const overlay = document.querySelector('[data-sm-confirm]')
  if (!overlay) return { ok: false, reason: 'no overlay' }
  const buttons = [...overlay.querySelectorAll('button')]
  const confirm = buttons.find((b) => /^(删除|Delete)$/.test((b.textContent || '').trim()))
  if (!confirm) return { ok: false, reason: 'no confirm button' }
  confirm.click()
  return { ok: true }
})
console.log('[delete] confirmed:', JSON.stringify(confirmDone))
await sleep(3000)
console.log('[t4] settings still shows Greeting:', await bodyHas('Greeting'))
await shot('m06-final')

await browser.close()
console.log('[pageerrors]', pageErrors.length, pageErrors.slice(0, 3))
console.log('[done]')
