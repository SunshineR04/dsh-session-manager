// Reproduce bug 2: delete an archived session from the settings page and
// watch whether it lingers in the sidebar, before and after a page reload.
import { mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const url = process.argv[2]
const outDir = process.argv[3] || 'e2e-artifacts'
if (!url) {
  console.error('usage: node scripts/e2e-bug2.mjs <url> [outdir]')
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
const shot = async (name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` })
  console.log(`[shot] ${outDir}/${name}.png`)
}

/** Session rows visible in the sidebar: aria buttons that are session menus. */
async function sidebarSessions() {
  return page.evaluate(() => {
    const rows = []
    for (const button of document.querySelectorAll('button[aria-label]')) {
      const label = button.getAttribute('aria-label') || ''
      if (!label.includes('的操作') || label.includes('工作区')) continue
      let node = button.parentElement
      while (node && node !== document.body) {
        const r = node.getBoundingClientRect()
        if (r.width > 120 && r.height > 20) {
          rows.push({ label, text: (node.textContent || '').replace(/\s+/g, ' ').slice(0, 90) })
          break
        }
        node = node.parentElement
      }
    }
    return rows
  })
}

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)
console.log('[before] sidebar rows:', JSON.stringify(await sidebarSessions(), null, 1))

// open settings -> section
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /^(设置|Settings)$/.test((b.textContent || '').trim()))
  if (button) button.click()
})
await sleep(2200)
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('button, span, div, a')]
  const hit = nodes.find((node) => node.children.length === 0 && /^(会话管理|Session Manager)$/.test((node.textContent || '').trim()))
  if (hit) (hit.closest('button') || hit).click()
})
await sleep(2200)

// identify the archived row(s) and click the delete button of the FIRST one
const sectionInfo = await page.evaluate(() => {
  const text = document.body.innerText
  const rows = [...document.querySelectorAll('div')]
  const candidate = rows.find((d) => {
    if (!d.offsetParent) return false
    const r = d.getBoundingClientRect()
    if (r.width < 300) return false
    const buttons = [...d.querySelectorAll('button')]
    return buttons.some((b) => /^(恢复|Restore)$/.test((b.textContent || '').trim()))
      && buttons.some((b) => /^(彻底删除|Delete permanently)$/.test((b.textContent || '').trim()))
  })
  return { hasSection: text.includes('已归档会话') || text.includes('Archived sessions'), rowFound: candidate !== null }
})
console.log('[settings]', JSON.stringify(sectionInfo))
await shot('b2-settings')

const deleted = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('div')]
  const candidate = rows.find((d) => {
    if (!d.offsetParent) return false
    const r = d.getBoundingClientRect()
    if (r.width < 300) return false
    const buttons = [...d.querySelectorAll('button')]
    return buttons.some((b) => /^(恢复|Restore)$/.test((b.textContent || '').trim()))
      && buttons.some((b) => /^(彻底删除|Delete permanently)$/.test((b.textContent || '').trim()))
  })
  if (!candidate) return null
  const title = candidate.querySelector('span')?.textContent?.slice(0, 40) ?? ''
  const del = [...candidate.querySelectorAll('button')].find((b) => /^(彻底删除|Delete permanently)$/.test((b.textContent || '').trim()))
  del.click()
  return title
})
console.log('[delete] row title:', deleted)
await sleep(900)
// confirm the delete
const confirmed = await page.evaluate(() => {
  const overlay = document.querySelector('[data-sm-confirm]')
  if (!overlay) return false
  const buttons = [...overlay.querySelectorAll('button')]
  const confirm = buttons.find((b) => /^(删除|Delete)$/.test((b.textContent || '').trim()))
  if (!confirm) return false
  confirm.click()
  return true
})
console.log('[delete] confirmed:', confirmed)
await sleep(3500)
await shot('b2-after-delete')
// close settings and inspect the sidebar
await page.keyboard.press('Escape')
await sleep(1500)
console.log('[after] sidebar rows:', JSON.stringify(await sidebarSessions(), null, 1))
const bodyMentions = await page.evaluate((title) => {
  const t = document.body.innerText
  return { deleted: title !== null && t.includes(title), toast: /已永久删除|permanently deleted/.test(t) }
}, deleted)
console.log('[after] body mentions:', JSON.stringify(bodyMentions))

// reload and re-check
await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)
console.log('[reload] sidebar rows:', JSON.stringify(await sidebarSessions(), null, 1))
await shot('b2-after-reload')
await browser.close()
console.log('[done]')
