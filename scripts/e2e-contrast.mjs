// Contrast acceptance check for the plugin's own danger text.
//
// Why this exists as a browser script rather than a render test: jsdom does not
// compute colours, and the failure is a THEME-DEPENDENT one that only shows up
// when the real design tokens resolve. Measured before the fix: the aliased
// red-400 was 4.24:1 on the dark card (#2c2c2e) and 3.29:1 on white, while
// red-600 was 4.50:1 on white and 3.10:1 on the dark card — the two themes fail
// in opposite directions, so no single scale entry clears AA in both.
//
// Read-only with respect to session data: it archives nothing and deletes
// nothing. It DOES need a row to measure, so run it against a seeded home whose
// archive set is non-empty (`deploy: node scripts/e2e-seed.mjs <home>` seeds one
// archived session).
// Run: node scripts/e2e-contrast.mjs <url> <e2e-home> [<screenshot-dir>]
import { mkdir } from 'node:fs/promises'

import puppeteer from 'puppeteer-core'

import { assertDisposableHome } from './e2e-guard.mjs'

const url = process.argv[2]
const e2eHome = process.argv[3]
const shotDir = process.argv[4] ?? null
if (!url || !e2eHome) {
  console.error('usage: node scripts/e2e-contrast.mjs <url> <e2e-home> [<screenshot-dir>]')
  process.exit(2)
}
// Reads only, but it is an e2e script against a live host: require the same
// disposable home the destructive ones require, so it can never be pointed at a
// home this repository did not create.
try {
  assertDisposableHome(e2eHome, { script: 'e2e-contrast' })
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
if (shotDir !== null) await mkdir(shotDir, { recursive: true })

/** WCAG relative luminance and contrast ratio. */
const srgb = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const luminance = (c) => 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2])
const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
/** Both the legacy `rgb()` and the modern `color(srgb …)` / `light-dark()` forms. */
const parseColor = (value) => {
  const modern = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(value ?? '')
  if (modern !== null) return [Number(modern[1]) * 255, Number(modern[2]) * 255, Number(modern[3]) * 255]
  const match = /rgba?\(([^)]+)\)/.exec(value ?? '')
  if (match === null) return null
  const parts = match[1].split(',').map((v) => Number(v.trim()))
  // A translucent colour is composited over the painted surface below it by the
  // caller; here only opaque values are comparable, so return the alpha too.
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 200)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dismissNotice = () => page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '继续')
  if (button !== undefined) button.click()
})

const openSettingsSection = async () => {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) => /^(设置|Settings)$/.test((b.textContent || '').trim()))
    if (button) button.click()
  })
  await sleep(2500)
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, span, div, a')]
    const hit = nodes.find((node) => node.children.length === 0 && /^(会话管理|Session Manager)$/.test((node.textContent || '').trim()))
    if (hit) (hit.closest('button') || hit).click()
  })
  await sleep(2500)
}

/** The plugin's danger TEXT surfaces, each with the surface it actually paints on. */
const MEASURE = () => {
  /** Walk up to the first ancestor that paints an opaque background. */
  const paintedSurface = (el) => {
    let node = el
    while (node !== null && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor
      const match = /rgba?\(([^)]+)\)/.exec(bg)
      if (match !== null) {
        const parts = match[1].split(',').map((v) => Number(v.trim()))
        if (parts.length < 4 || parts[3] > 0.9) return { bg, source: String(node.className || '').slice(0, 30) }
      }
      node = node.parentElement
    }
    return { bg: getComputedStyle(document.body).backgroundColor, source: 'body' }
  }
  const sample = (label, el) => {
    if (el === null || el === undefined) return null
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return { label, color: cs.color, fontPx: parseFloat(cs.fontSize), ...paintedSurface(el) }
  }
  const buttons = [...document.querySelectorAll('button')]
  const rowDelete = buttons.find((b) => /^(彻底删除|Delete permanently)$/.test((b.textContent || '').trim()))
  return {
    // Whether the ARCHIVED ROW rendered at all. The header's bulk-delete and
    // Refresh buttons render on an empty archive set too, so "we measured
    // something" is not the same question — and the docs promise exit 2 when
    // there is nothing to measure.
    hasRowDelete: rowDelete !== undefined,
    samples: [
      sample('row delete', rowDelete),
      sample('bulk delete', buttons.find((b) => /删除选中|Delete .* selected/.test(b.textContent || ''))),
      sample('refresh (control)', buttons.find((b) => /^(刷新|Refresh)$/.test((b.textContent || '').trim()))),
    ].filter((entry) => entry !== null),
  }
}

const results = []
// How many passes actually saw the archived ROW (not just the header controls).
let rowSamples = 0
for (const scheme of ['dark', 'light']) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await sleep(9000)
  await dismissNotice()
  await sleep(1200)
  await openSettingsSection()
  if (shotDir !== null) await page.screenshot({ path: `${shotDir}/contrast-${scheme}.png` })

  const measured = await page.evaluate(MEASURE)
  if (measured.hasRowDelete) rowSamples += 1
  if (measured.samples.length === 0) {
    console.log(`[${scheme}] nothing to measure — no archived row rendered (seed a home with an archived session)`)
    continue
  }
  console.log(`\n=== ${scheme} theme ===`)
  for (const entry of measured.samples) {
    const fg = parseColor(entry.color)
    const bg = parseColor(entry.bg)
    if (fg === null || bg === null) {
      console.log(`  ? ${entry.label}: unparseable colours (${entry.color} on ${entry.bg})`)
      results.push({ scheme, label: entry.label, ratio: null, pass: false })
      continue
    }
    const value = ratio(fg, bg)
    // `>= 4.5` with no fudge factor on purpose: the shipped literals were chosen
    // to clear the floor with margin (measured 4.83 light / 4.73 dark), because
    // an earlier candidate (the scale's own red-600) computed to 4.4976 — under
    // the line — and a tolerance would have hidden exactly that.
    const pass = value >= 4.5
    results.push({ scheme, label: entry.label, ratio: value, pass, color: entry.color, bg: entry.bg, fontPx: entry.fontPx })
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${entry.label.padEnd(20)} ${String(entry.fontPx + 'px').padEnd(7)} ${value.toFixed(2)}  ${entry.color} on ${entry.bg} (${entry.source})`)
  }
}

await browser.close()

if (results.length === 0 || rowSamples === 0) {
  console.error('\nno archived ROW was measured — the seeded home needs an ARCHIVED session for the settings page to render one. The header\'s bulk-delete and Refresh buttons render on an empty archive set too, so measuring them alone is not the acceptance this script promises.')
  process.exit(2)
}
// Every danger-text surface this plugin paints must clear AA at its own size.
const danger = results.filter((entry) => entry.label !== 'refresh (control)')
const failures = danger.filter((entry) => !entry.pass)
console.log(`\n[done] ${danger.length} danger-text measurement(s), ${failures.length} below 4.5:1`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure.scheme}/${failure.label} ${failure.ratio === null ? 'n/a' : failure.ratio.toFixed(2)}`)
  throw new Error(`${failures.length} contrast check(s) failed`)
}
