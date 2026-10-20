#!/usr/bin/env node
// scripts/derive-version.mjs
//
// The Windows twin of scripts/derive-version.sh. This checkout has no bash, so
// android/app/build.gradle's version derivation (which shells out to the .sh)
// and scripts/build-android-debug.ps1 have nothing to call. This file is that
// caller-side equivalent: it reproduces the SAME two values from the SAME
// inputs, so a build made through either path lands on the same
// versionCode/versionName pair.
//
// Rules mirrored from the .sh (read that file's header before changing either):
//   * versionCode = (count of `v<digit>*` tags merged into the ref) + OFFSET(1),
//     never below 1. A shallow checkout, a missing git or a detached copy all
//     still produce a legal versionCode — an empty versionCode makes
//     `assembleDebug` fail with an opaque manifest error (Review Focus 1).
//   * versionName = the exact `v*` tag with `v` stripped; else `git describe`
//     output with `v` stripped; else `0.0.0-dev+<short sha>`; else the bare
//     `0.0.0-dev` placeholder.
//   * A `.pocketshell-version-pin` file is consulted AHEAD of git, so a
//     `.git`-less copy derives exactly what the checkout it was copied from
//     derives (issue #2381).
//   * Never fails the build. Every path falls through to a documented value.
//
// Usage:
//   node scripts/derive-version.mjs version-code [--ref REF]
//   node scripts/derive-version.mjs version-name [--ref REF]
//   node scripts/derive-version.mjs both [--ref REF]      (default; KEY=VALUE)
//   node scripts/derive-version.mjs --self-test

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_CODE_OFFSET = 1
const VERSION_PIN_FILE_NAME = '.pocketshell-version-pin'

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    })
  } catch {
    return null
  }
}

function readVersionPin(repo) {
  const pinFile = path.join(repo, VERSION_PIN_FILE_NAME)
  if (!existsSync(pinFile)) return null

  let code = ''
  let name = ''
  let raw
  try {
    raw = readFileSync(pinFile, 'utf8')
  } catch {
    return null
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('VERSION_CODE=')) code = line.slice('VERSION_CODE='.length).trim()
    if (line.startsWith('VERSION_NAME=')) name = line.slice('VERSION_NAME='.length).trim()
  }

  if (!/^[1-9][0-9]*$/.test(code) || !name) {
    process.stderr.write(
      `derive-version.mjs: ignoring malformed version pin at ${pinFile} ` +
        `(VERSION_CODE=${code || '<missing>'} VERSION_NAME=${name || '<missing>'})\n`,
    )
    return null
  }
  return { code: Number(code), name }
}

// A tree with no git of its own has no version to derive: answer with the
// placeholder rather than a different repository's history (issue #2381).
function gitTreeUsable(repo) {
  if (!existsSync(path.join(repo, '.git'))) return false
  return git(repo, ['rev-parse', '--is-inside-work-tree']) !== null
}

function deriveVersionCode(repo, ref) {
  const pin = readVersionPin(repo)
  if (pin) return pin.code
  if (!gitTreeUsable(repo)) return VERSION_CODE_OFFSET

  const tags = git(repo, ['tag', '--list', 'v[0-9]*', '--merged', ref])
  if (tags === null) return VERSION_CODE_OFFSET

  const count = tags
    .split(/\r?\n/)
    .filter((line) => /^v[0-9]/.test(line.trim()))
    .length
  return count + VERSION_CODE_OFFSET
}

function deriveVersionName(repo, ref) {
  const pin = readVersionPin(repo)
  if (pin) return pin.name
  if (!gitTreeUsable(repo)) return '0.0.0-dev'

  const exact = git(repo, ['describe', '--exact-match', '--tags', '--match', 'v[0-9]*', ref])
  if (exact && exact.trim()) return exact.trim().replace(/^v/, '')

  const describe = git(repo, ['describe', '--tags', '--match', 'v[0-9]*', '--always', ref])
  if (describe && describe.trim()) {
    const value = describe.trim()
    return value.startsWith('v') ? value.slice(1) : `0.0.0-dev+${value}`
  }
  return '0.0.0-dev'
}

// A versionCode below 1 is not a legal Android version, and an empty one fails
// `assembleDebug` far from here. Assert instead of trusting the fallback.
function assertUsable(code, name, where) {
  if (!Number.isInteger(code) || code < 1) {
    process.stderr.write(`derive-version.mjs: refusing to emit versionCode=${code} (${where})\n`)
    process.exit(2)
  }
  if (typeof name !== 'string' || name.trim() === '') {
    process.stderr.write(`derive-version.mjs: refusing to emit an empty versionName (${where})\n`)
    process.exit(2)
  }
}

function usage() {
  process.stdout.write(
    'usage: node scripts/derive-version.mjs [version-code|version-name|both|--self-test] [--ref REF]\n',
  )
}

function runSelfTest() {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'derive-version-mjs-'))
  let failures = 0

  const check = (desc, actual, expected) => {
    if (String(actual) === String(expected)) {
      process.stdout.write(`  ok: ${desc} -> ${actual}\n`)
    } else {
      process.stderr.write(`  FAIL: ${desc} -> got ${actual}, expected ${expected}\n`)
      failures += 1
    }
  }

  try {
    const repo = path.join(sandbox, 'repo')
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '--quiet', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Self Test'])

    // Unborn HEAD: must not crash.
    check('empty repo versionCode', deriveVersionCode(repo, 'HEAD'), 1)
    check('empty repo versionName', deriveVersionName(repo, 'HEAD'), '0.0.0-dev')

    git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'c1'])
    const shortSha = git(repo, ['rev-parse', '--short', 'HEAD']).trim()
    check('untagged versionName', deriveVersionName(repo, 'HEAD'), `0.0.0-dev+${shortSha}`)

    git(repo, ['tag', 'v0.1.0'])
    check('v0.1.0 versionName', deriveVersionName(repo, 'HEAD'), '0.1.0')
    check('v0.1.0 versionCode', deriveVersionCode(repo, 'HEAD'), 1 + VERSION_CODE_OFFSET)

    git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'c2'])
    check('post-tag versionCode', deriveVersionCode(repo, 'HEAD'), 1 + VERSION_CODE_OFFSET)

    git(repo, ['tag', 'v0.1.1'])
    check('monotonic versionCode', deriveVersionCode(repo, 'HEAD'), 2 + VERSION_CODE_OFFSET)

    // A stray v-prefixed non-version tag must not be counted (#2646).
    git(repo, ['tag', 'validated-rc'])
    check('stray v-prefixed tag ignored', deriveVersionCode(repo, 'HEAD'), 2 + VERSION_CODE_OFFSET)

    // A `.git`-less copy is the placeholder, and the pin overrides it.
    const copy = path.join(sandbox, 'gate-copy')
    mkdirSync(copy, { recursive: true })
    check('detached copy without a pin', deriveVersionName(copy, 'HEAD'), '0.0.0-dev')
    writeFileSync(
      path.join(copy, VERSION_PIN_FILE_NAME),
      `VERSION_CODE=7\nVERSION_NAME=1.2.3\n`,
    )
    check('pinned copy versionName', deriveVersionName(copy, 'HEAD'), '1.2.3')
    check('pinned copy versionCode', deriveVersionCode(copy, 'HEAD'), 7)

    // The pin wins over a usable git tree (precedence, not fallback).
    writeFileSync(
      path.join(repo, VERSION_PIN_FILE_NAME),
      `VERSION_CODE=9\nVERSION_NAME=9.8.7\n`,
    )
    check('pin wins over git', deriveVersionName(repo, 'HEAD'), '9.8.7')
    rmSync(path.join(repo, VERSION_PIN_FILE_NAME))
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      /* leave the scratch dir behind rather than fail the self-test */
    }
  }

  if (failures !== 0) {
    process.stderr.write(`SELF-TEST FAILED: ${failures} case(s)\n`)
    process.exit(1)
  }
  process.stdout.write('SELF-TEST OK: local tag / sha / pin derivation matches derive-version.sh\n')
}

function main(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'both'
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv

  if (command === '--self-test' || argv.includes('--self-test')) {
    runSelfTest()
    return
  }
  if (command === '-h' || command === '--help') {
    usage()
    return
  }
  if (!['version-code', 'version-name', 'both'].includes(command)) {
    process.stderr.write(`unknown command: ${command}\n`)
    usage()
    process.exit(2)
  }

  let ref = 'HEAD'
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--ref' && rest[i + 1]) {
      ref = rest[i + 1]
      i += 1
    } else {
      process.stderr.write(`unknown argument: ${rest[i]}\n`)
      process.exit(2)
    }
  }

  const code = deriveVersionCode(ROOT_DIR, ref)
  const name = deriveVersionName(ROOT_DIR, ref)
  assertUsable(code, name, `ref ${ref}`)

  if (command === 'version-code') process.stdout.write(`${code}\n`)
  else if (command === 'version-name') process.stdout.write(`${name}\n`)
  else process.stdout.write(`VERSION_CODE=${code}\nVERSION_NAME=${name}\n`)
}

main(process.argv.slice(2))
