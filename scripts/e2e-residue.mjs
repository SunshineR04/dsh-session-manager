// Residue acceptance run (diagnosis doc §6 / plan step 2): delete an OPEN
// session through the red menu item and prove the deleted id never renders in
// the sidebar again — neither in the default view nor with
// 视图选项 → 全部对话（显示已归档）, where the archive tombstone is visible by
// design. Any queued husk id passed on the command line must be gone as well.
//
// Run: node scripts/e2e-residue.mjs <url> --home <e2e-home> [<queued-husk-id>...]
//
// `--home` is REQUIRED: this script permanently deletes a session through the
// instance behind <url>, and a URL alone cannot prove which home that instance
// serves. The home must carry the marker scripts/e2e-seed.mjs writes — see
// scripts/e2e-guard.mjs.
import puppeteer from 'puppeteer-core'

import { assertDisposableHome } from './e2e-guard.mjs'

const argv = process.argv.slice(2)
const homeIndex = argv.indexOf('--home')
const e2eHome = homeIndex === -1 ? undefined : argv[homeIndex + 1]
const positional = homeIndex === -1 ? argv : argv.filter((_, index) => index !== homeIndex && index !== homeIndex + 1)
const url = positional[0]
const huskIds = positional.slice(1)
if (!url) process.exit(2)
try {
  assertDisposableHome(e2eHome, { script: 'e2e-residue' })
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 200)))
page.on('response', (response) => {
  if (response.status() >= 400) console.log('[http]', response.status(), response.url())
})
page.on('console', (message) => {
  if (message.type() === 'error') console.log('[console.error]', String(message.text()).slice(0, 200))
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const rows = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key]')].map((el) => ({
  key: el.getAttribute('data-row-key'),
  text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 60),
  expanded: el.getAttribute('aria-expanded'),
  archived: /archived/i.test(el.className || ''),
  rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
})))

const clickRow = async (key) => {
  const target = (await rows()).find((row) => row.key === key)
  if (target === undefined) return false
  await page.mouse.click(target.rect.x + 40, target.rect.y + target.rect.h / 2)
  await sleep(1200)
  return true
}

const pickViewOption = async (fragment) => {
  const opened = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="视图选项"]')
    if (button === null) return false
    button.click()
    return true
  })
  if (!opened) return false
  await sleep(900)
  const picked = await page.evaluate((needle) => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => (el.textContent || '').includes(needle))
    if (item === undefined) return false
    item.click()
    return true
  }, fragment)
  await sleep(1500)
  return picked
}

/** Sidebar session ids currently rendered anywhere in the tree. */
const renderedSessionIds = async () => (await rows())
  .map((row) => (row.key.startsWith('session:') ? row.key.slice('session:'.length) : null))
  .filter((id) => id !== null)

const expandUngrouped = async () => {
  const group = (await rows()).find((row) => row.key === 'workspace:')
  if (group === undefined) return false
  if (group.expanded === 'false') await clickRow('workspace:')
  return true
}

const report = { steps: [] }
const record = (step, value) => {
  report.steps.push({ step, value })
  console.log(`[${step}]`, JSON.stringify(value))
}

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)

// The preview notice blocks the sidebar until dismissed.
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '继续')
  if (button !== undefined) button.click()
})
await sleep(1500)

record('boot-rows', await rows())

// Hardest view first: archived rows are visible here, so a lingering tombstone
// WOULD render (this is the reported symptom's view).
const showArchived = await pickViewOption('显示已归档')
await expandUngrouped()
const visibleBefore = await renderedSessionIds()
record('show-archived-enabled', { showArchived, visible: visibleBefore })
for (const husk of huskIds) {
  if (visibleBefore.includes(husk)) throw new Error(`queued husk ${husk} is rendered in the archive view`)
}

// Open a non-blank, NON-archived session so the delete takes the OPEN-session
// path: that is the only path that leaves an archive tombstone behind. A seeded
// home can run out of them, so restore one archived session first when needed.
const isCandidate = (row) => row.key.startsWith('session:')
  && !row.archived && !row.text.startsWith('新会话') && !huskIds.some((husk) => row.key.endsWith(husk))

let target = (await rows()).find(isCandidate)
if (target === undefined) {
  const restored = await page.evaluate(async () => {
    const post = async (endpoint, payload) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(`/api/session-manager/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: `session-manager/${endpoint}`, payload }),
      })
      const body = await response.json()
      return body.result
    }
    const listed = await post('list', {})
    if (listed === null || listed === undefined || listed.ok !== true) return { ok: false, reason: 'archive list failed' }
    // The seeded registry can name sessions whose files the source home no
    // longer has; restore refuses those, so try each candidate in order.
    const candidates = (listed.value.items || []).filter((item) => item.blank !== true && typeof item.sessionId === 'string')
    const failures = []
    for (const candidate of candidates) {
      const answer = await post('restore', { sessionId: candidate.sessionId })
      if (answer !== null && answer !== undefined && answer.ok === true) return { ok: true, sessionId: candidate.sessionId }
      failures.push(`${candidate.sessionId}: ${answer?.error?.code ?? 'failed'}`)
    }
    return { ok: false, reason: failures.length > 0 ? failures.join(', ') : 'no restorable archived session' }
  })
  record('restore-for-target', restored)
  if (restored.ok !== true) {
    // With queued husks on the command line the load-time precondition above is
    // already the assertion under test; a spent fixture (no restorable session
    // left) must not turn that pass into a failure.
    if (huskIds.length > 0) {
      record('precondition-only', { huskAssertionsPassed: true, reason: restored.reason ?? 'restore failed' })
      await browser.close()
      console.log('[done] husk precondition passed (no deletable session left to exercise the delete)')
      process.exit(0)
    }
    throw new Error(`no deletable session available (${restored.reason ?? 'restore failed'})`)
  }
  await sleep(2500)
  await pickViewOption('显示已归档')
  target = (await rows()).find((row) => row.key === `session:${restored.sessionId}`)
    ?? (await rows()).find(isCandidate)
}
if (target === undefined) throw new Error('no non-archived session row to delete')
const targetId = target.key.slice('session:'.length)
record('target', { targetId, text: target.text, archived: target.archived })
if (!(await clickRow(target.key))) throw new Error('the target row could not be opened')
await sleep(2500)

const opened = (await renderedSessionIds()).includes(targetId)
record('opened-live', { opened })

// Delete through the official "…" menu → the plugin's red row → confirm.
// The row actions only exist while the row is hovered: move onto it FIRST, then
// measure the trigger (its rect is 0x0 until the row reveals its actions).
const rowBox = (await rows()).find((row) => row.key === target.key)
await page.mouse.move(rowBox.rect.x + rowBox.rect.w / 2, rowBox.rect.y + rowBox.rect.h / 2)
await sleep(900)
const menuBox = await page.evaluate((key) => {
  const row = document.querySelector(`[data-row-key="${key}"]`)
  const button = row === null ? null : row.querySelector('button[aria-label^="会话"]')
  if (button === null) return null
  const r = button.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}, target.key)
if (menuBox === null) throw new Error('the row has no menu trigger (is it blank?)')
await page.mouse.click(menuBox.x, menuBox.y)
await sleep(1200)
const menuItems = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent || '').trim().slice(0, 30)))
record('menu-items', menuItems)
const clickedDelete = await page.evaluate(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => (el.textContent || '').includes('彻底删除'))
  if (item === undefined) return false
  item.click()
  return true
})
if (!clickedDelete) throw new Error('the red delete row is missing from the menu')
await sleep(1500)
const confirmed = await page.evaluate(() => {
  const overlay = document.querySelector('[data-sm-confirm]')
  if (overlay === null) return false
  const button = [...overlay.querySelectorAll('button')].find((b) => /^(删除|Delete)$/.test((b.textContent || '').trim()))
  if (button === undefined) return false
  button.click()
  return true
})
record('confirmed', confirmed)
await sleep(3500)

const toast = await page.evaluate(() => {
  const el = document.querySelector('[data-sm-toast]')
  return el === null ? null : el.textContent.slice(0, 160)
})
record('toast', toast)
// Pin the OPEN-session path: only that delete reports the lingering in-memory
// copy, and only that shape leaves the tombstone this run is about.
if (toast === null || !toast.includes('残留的内存副本')) {
  throw new Error(`the delete did not take the open-session path (toast: ${String(toast)})`)
}

// Give the residue watch its full window (repair debounce + a list pull).
await sleep(5000)
await expandUngrouped()
const afterDelete = await renderedSessionIds()
record('after-delete-show-archived', { rendered: afterDelete, targetStillThere: afterDelete.includes(targetId) })

// And the default view must be clean too.
await pickViewOption('隐藏已归档')
await expandUngrouped()
const defaultView = await renderedSessionIds()
record('after-delete-default', { rendered: defaultView, targetStillThere: defaultView.includes(targetId) })

if (afterDelete.includes(targetId)) throw new Error('the deleted session is rendered in the archive view')
if (defaultView.includes(targetId)) throw new Error('the deleted session is rendered in the default view')
for (const husk of huskIds) {
  if (afterDelete.includes(husk)) throw new Error(`queued husk ${husk} is rendered in the archive view`)
}

await browser.close()
console.log('[done] residue acceptance passed')
