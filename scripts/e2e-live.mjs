// Live-session lifecycle experiment v2: open session -> menu delete (expect
// session/running refusal) -> switch to another session -> menu delete again.
import { join, dirname } from 'node:path'
import puppeteer from 'puppeteer-core'

const url = process.argv[2]
if (!url) process.exit(2)
const { readFile } = await import('node:fs/promises')
const { fileURLToPath } = await import('node:url')
const spec = await (async () => {
  try {
    return JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'e2e-seed.local.json'), 'utf8'))
  } catch {
    return {}
  }
})()
const otherWorkspaceTitle = (() => {
  const titles = (Array.isArray(spec.workspaces) ? spec.workspaces : []).map((workspace) => workspace.title)
  return titles.find((title) => title !== 'test') ?? titles[0] ?? process.env.E2E_OTHER_WORKSPACE ?? 'other'
})()
// The live session this experiment targets — machine-specific, so it lives in
// the gitignored local spec (or the env), never in the repo.
const TITLE = spec.targetSessionTitle ?? process.env.E2E_SESSION_TITLE ?? 'Greeting'
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', String(m.text()).slice(0, 200))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rowRect(titleFragment) {
  return page.evaluate((frag) => {
    const buttons = [...document.querySelectorAll('button[aria-label]')]
    const ellipsis = buttons.find((b) => (b.getAttribute('aria-label') || '').includes(frag))
    if (!ellipsis) return null
    let node = ellipsis.parentElement
    while (node && node !== document.body) {
      const r = node.getBoundingClientRect()
      if (r.width > 120 && r.height > 20) return { x: r.x, y: r.y, w: r.width, h: r.height }
      node = node.parentElement
    }
    return null
  }, titleFragment)
}
async function clickRow(frag) {
  const r = await rowRect(frag)
  if (r === null) return false
  await page.mouse.click(r.x + 30, r.y + r.h / 2)
  await sleep(2500)
  return true
}
async function menuDelete(frag) {
  const r = await rowRect(frag)
  if (r === null) return 'no-row'
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
  await sleep(700)
  const btn = await page.evaluate((frag) => {
    const buttons = [...document.querySelectorAll('button[aria-label]')]
    const ellipsis = buttons.find((b) => (b.getAttribute('aria-label') || '').includes(frag) && b.offsetParent !== null)
    if (!ellipsis) return null
    const rect = ellipsis.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, frag)
  if (btn === null) return 'no-visible-ellipsis'
  await page.mouse.click(btn.x, btn.y)
  await sleep(1100)
  const red = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const target = items.find((i) => i.textContent.trim() === '彻底删除' || i.textContent.trim() === 'Delete permanently')
    if (!target) return null
    const rect = target.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  if (red === null) return 'no-red-item'
  await page.mouse.click(red.x, red.y)
  await sleep(900)
  const confirmed = await page.evaluate(() => {
    const overlay = document.querySelector('[data-sm-confirm]')
    if (!overlay) return 'no-overlay'
    const buttons = [...overlay.querySelectorAll('button')]
    const confirm = buttons.find((b) => /^(删除|Delete)$/.test((b.textContent || '').trim()))
    if (!confirm) return 'no-confirm'
    confirm.click()
    return true
  })
  await sleep(2500)
  return confirmed
}
async function visibleError() {
  return page.evaluate(() => {
    const toast = document.querySelector('[data-sm-toast]')
    if (toast) return `toast: ${toast.textContent.slice(0, 120)}`
    return null
  })
}
async function sidebarTitles() {
  return page.evaluate(() => {
    const out = []
    for (const b of document.querySelectorAll('button[aria-label]')) {
      const label = b.getAttribute('aria-label') || ''
      if (label.includes('的操作') && !label.includes('工作区')) {
        let node = b.parentElement
        while (node && node !== document.body) {
          const r = node.getBoundingClientRect()
          if (r.width > 120 && r.height > 20) {
            out.push((node.textContent || '').replace(/\s+/g, ' ').slice(0, 70))
            break
          }
          node = node.parentElement
        }
      }
    }
    return out
  })
}

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(10000)
console.log('[0] sidebar:', JSON.stringify(await sidebarTitles()))

console.log('[1] open session A:', await clickRow(TITLE))
console.log('[1] menu delete A (live):', await menuDelete(TITLE))
console.log('[1] visible error:', await visibleError())

// switch: click the "新会话" row of the OTHER workspace group
const switched = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
  const candidates = buttons.filter((b) => {
    const label = b.getAttribute('aria-label') || ''
    return label.includes('新会话') && label.includes(otherWorkspaceTitle)
  })
  if (candidates.length === 0) return false
  candidates[0].click()
  return true
})
console.log(`[2] switch to ${otherWorkspaceTitle} new session:`, switched)
await sleep(3000)

console.log('[3] menu delete A again:', await menuDelete(TITLE))
console.log('[3] visible error:', await visibleError())
console.log('[3] sidebar after:', JSON.stringify(await sidebarTitles()))
await browser.close()
console.log('[done]')
