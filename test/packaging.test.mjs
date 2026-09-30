// Packaging guards. The rule AGENTS.md states in prose — "a new runtime file must
// be added to BOTH `package.json → files` AND `package.json → scripts.test`" — was
// documentation only, and it has already been the failure mode more than once: a
// file that is not in `files` makes the published package broken while every local
// run stays green, and a suite that is not in `scripts.test` never runs at all.
// These checks read the filesystem and the manifest, so they need no dsh and never
// skip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const list = (dir, suffix) => readdirSync(join(root, dir)).filter((name) => name.endsWith(suffix)).map((name) => `${dir}/${name}`).sort()

const libFiles = list('lib', '.js')
const suiteFiles = list('test', '.test.mjs')
const testScript = pkg.scripts.test
const checkScript = pkg.scripts.check

test('every runtime file in lib/ is shipped in package.json -> files', () => {
  const missing = libFiles.filter((file) => !pkg.files.includes(file))
  assert.deepEqual(missing, [], `not in the published package (add to package.json -> files): ${missing.join(', ')}`)
})

test('every runtime file in lib/ is syntax-checked by scripts.check', () => {
  const missing = libFiles.filter((file) => !checkScript.includes(file))
  assert.deepEqual(missing, [], `not covered by scripts.check: ${missing.join(', ')}`)
})

test('every suite on disk is named in scripts.test', () => {
  const missing = suiteFiles.filter((file) => !testScript.includes(file))
  assert.deepEqual(missing, [], `a suite NOT named there never runs, locally or in CI: ${missing.join(', ')}`)
})

test('scripts.test names no suite that does not exist', () => {
  const named = [...testScript.matchAll(/test\/[\w.-]+\.test\.mjs/g)].map((match) => match[0])
  const absent = named.filter((file) => !existsSync(join(root, file)))
  assert.deepEqual(absent, [], `listed but missing on disk: ${absent.join(', ')}`)
  assert.equal(new Set(named).size, named.length, 'a suite listed twice runs twice')
})

test('the package entry points resolve', () => {
  for (const target of [pkg.main, pkg.exports['.'], pkg.exports['./client'], pkg.dsh.bundle.patch]) {
    assert.ok(existsSync(join(root, target)), `${target} does not exist`)
  }
})

test('the bundle patch entry this package installs is the one it ships', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('cordis.patch.yml'), 'the patch must be in files or the install cannot apply it')
})
