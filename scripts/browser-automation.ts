import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'

export type BrowserKind = 'chrome' | 'safari'
export type AutomationBrowserKind = BrowserKind | 'firefox'

export type BrowserSession = {
  navigate: (url: string) => void
  readReportText: () => string
  close: () => void
}

export type BrowserSessionOptions = {
  foreground?: boolean
}

export type PageServer = {
  baseUrl: string
  process: ChildProcess | null
}

export type BrowserAutomationLock = {
  release: () => void
}

function runAppleScript(lines: string[]): string {
  return execFileSync(
    'osascript',
    lines.flatMap(line => ['-e', line]),
    { encoding: 'utf8' },
  ).trim()
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function getAvailablePort(requestedPort: number | null = null): Promise<number> {
  if (requestedPort !== null && Number.isFinite(requestedPort) && requestedPort > 0) {
    return requestedPort
  }

  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Failed to allocate a free port'))
        return
      }

      const { port } = address
      server.close(error => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

const LOCK_DIR = join(process.env['TMPDIR'] ?? '/tmp', 'pretext-browser-automation-locks')

type LockMetadata = {
  pid: number
  startedAt: number
}

function readLockMetadata(lockPath: string): LockMetadata | null {
  try {
    const raw = readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<LockMetadata>
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== 'number'
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
    }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EPERM'
    ) {
      return true
    }
    return false
  }
}

export async function acquireBrowserAutomationLock(
  browser: AutomationBrowserKind,
  timeoutMs = 120_000,
): Promise<BrowserAutomationLock> {
  mkdirSync(LOCK_DIR, { recursive: true })
  const lockPath = join(LOCK_DIR, `${browser}.lock`)
  const start = Date.now()

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
      }))
      let released = false
      return {
        release() {
          if (released) return
          released = true
          try {
            closeSync(fd)
          } catch {
            // Ignore close races during teardown.
          }
          try {
            rmSync(lockPath)
          } catch {
            // Best effort cleanup.
          }
        },
      }
    } catch (error) {
      if (!(error instanceof Error) || !String(error).includes('EEXIST')) throw error
      const metadata = readLockMetadata(lockPath)
      if (metadata !== null && !isProcessAlive(metadata.pid)) {
        try {
          rmSync(lockPath)
          continue
        } catch {
          // Another process may have replaced or removed it. Retry normally.
        }
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out waiting for ${browser} automation lock`)
      }
      await sleep(250)
    }
  }
}

async function canReachUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

const LOOPBACK_BASES = [
  'http://127.0.0.1',
  'http://localhost',
  'http://[::1]',
]

async function resolveBaseUrl(port: number, pathname: string): Promise<string | null> {
  for (const base of LOOPBACK_BASES) {
    const url = `${base}:${port}${pathname}`
    if (await canReachUrl(url)) {
      return `${base}:${port}`
    }
  }
  return null
}

function extractReportTextFromUrl(url: string): string {
  const hashIndex = url.indexOf('#report=')
  if (hashIndex === -1) return ''
  return decodeURIComponent(url.slice(hashIndex + '#report='.length))
}

function createSafariSession(_options: BrowserSessionOptions): BrowserSession {
  const windowIdRaw = runAppleScript([
    'tell application "Safari" to activate',
    'tell application "Safari"',
    'set targetDocument to make new document with properties {URL:"about:blank"}',
    'return id of front window as string',
    'end tell',
  ])

  const windowId = Number.parseInt(windowIdRaw, 10)
  if (!Number.isFinite(windowId)) {
    throw new Error(`Failed to create Safari automation window: ${windowIdRaw}`)
  }

  return {
    navigate(url) {
      runAppleScript([
        'tell application "Safari" to activate',
        'tell application "Safari"',
        `set targetWindow to first window whose id is ${windowId}`,
        'set index of targetWindow to 1',
        `set current tab of targetWindow to current tab of targetWindow`,
        `set URL of current tab of targetWindow to ${JSON.stringify(url)}`,
        'end tell',
      ])
    },
    readReportText() {
      try {
        const url = runAppleScript([
          'tell application "Safari"',
          `return URL of current tab of (first window whose id is ${windowId})`,
          'end tell',
        ])
        return extractReportTextFromUrl(url)
      } catch {
        return ''
      }
    },
    close() {
      try {
        runAppleScript([
          'tell application "Safari"',
          `close (first window whose id is ${windowId})`,
          'end tell',
        ])
      } catch {
        // Ignore cleanup failures if the user already closed the window.
      }
    },
  }
}

function createChromeSession(options: BrowserSessionOptions): BrowserSession {
  const scriptLines = [
    'tell application "Google Chrome"',
    'if (count of windows) = 0 then make new window',
    'set targetWindow to front window',
    'set targetTab to make new tab at end of tabs of targetWindow with properties {URL:"about:blank"}',
  ]

  if (options.foreground === true) {
    scriptLines.splice(1, 0, 'activate')
    scriptLines.push('set active tab index of targetWindow to (count of tabs of targetWindow)')
  }

  scriptLines.push('return (id of targetWindow as string) & "," & (id of targetTab as string)')
  scriptLines.push('end tell')

  const identifiers = runAppleScript(scriptLines)

  const [windowIdRaw, tabIdRaw] = identifiers.split(',')
  const windowId = Number.parseInt(windowIdRaw ?? '', 10)
  const tabId = Number.parseInt(tabIdRaw ?? '', 10)
  if (!Number.isFinite(windowId) || !Number.isFinite(tabId)) {
    throw new Error(`Failed to create Chrome automation tab: ${identifiers}`)
  }

  return {
    navigate(url) {
      runAppleScript([
        'tell application "Google Chrome"',
        `set targetWindow to first window whose id is ${windowId}`,
        `set URL of (first tab of targetWindow whose id is ${tabId}) to ${JSON.stringify(url)}`,
        'end tell',
      ])
    },
    readReportText() {
      try {
        const url = runAppleScript([
          'tell application "Google Chrome"',
          `set targetWindow to first window whose id is ${windowId}`,
          `return URL of (first tab of targetWindow whose id is ${tabId})`,
          'end tell',
        ])
        return extractReportTextFromUrl(url)
      } catch {
        return ''
      }
    },
    close() {
      try {
        runAppleScript([
          'tell application "Google Chrome"',
          `set targetWindow to first window whose id is ${windowId}`,
          `close (first tab of targetWindow whose id is ${tabId})`,
          'end tell',
        ])
      } catch {
        // Ignore cleanup failures if the user already closed the tab/window.
      }
    },
  }
}

export function createBrowserSession(
  browser: BrowserKind,
  options: BrowserSessionOptions = {},
): BrowserSession {
  return browser === 'safari' ? createSafariSession(options) : createChromeSession(options)
}

export async function ensurePageServer(
  port: number,
  pathname: string,
  cwd: string,
): Promise<PageServer> {
  const existingBaseUrl = await resolveBaseUrl(port, pathname)
  if (existingBaseUrl !== null) {
    return { baseUrl: existingBaseUrl, process: null }
  }

  const serverProcess = spawn('/bin/zsh', ['-lc', `bun --port=${port} --no-hmr pages/*.html`], {
    cwd,
    stdio: 'ignore',
  })

  const start = Date.now()
  while (Date.now() - start < 20_000) {
    const baseUrl = await resolveBaseUrl(port, pathname)
    if (baseUrl !== null) {
      return { baseUrl, process: serverProcess }
    }
    await sleep(100)
  }

  throw new Error(`Timed out waiting for local Bun server on port ${port}${pathname}`)
}

export async function loadHashReport<T extends { requestId?: string }>(
  session: BrowserSession,
  url: string,
  expectedRequestId: string,
  browser: BrowserKind,
  timeoutMs = 60_000,
): Promise<T> {
  session.navigate(url)

  const attempts = Math.max(1, Math.ceil(timeoutMs / 100))
  for (let i = 0; i < attempts; i++) {
    await sleep(100)
    const reportJson = session.readReportText()
    if (reportJson === '' || reportJson === 'null') continue

    const report = JSON.parse(reportJson) as T
    if (report.requestId === expectedRequestId) {
      return report
    }
  }

  throw new Error(`Timed out waiting for report from ${browser}`)
}
