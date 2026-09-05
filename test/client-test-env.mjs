// Browser-ish globals for client render tests. Import this module FIRST —
// it must run before React is imported (the act() environment flag is
// captured at import time).
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.IS_RE_ACT_ENVIRONMENT = true
