import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  acquireBrowserAutomationLock,
  createBrowserSession,
  ensurePageServer,
  getAvailablePort,
  loadHashReport,
  type BrowserKind,
} from './browser-automation.ts'

type AccuracyMismatch = {
  label: string
  font: string
  fontSize: number
  lineHeight: number
  width: number
  actual: number
  predicted: number
  diff: number
  text: string
  diagnosticLines?: string[]
}

type AccuracyRow = {
  label: string
  font: string
  fontSize: number
  lineHeight: number
  width: number
  actual: number
  predicted: number
  diff: number
}

type AccuracyReport = {
  status: 'ready' | 'error'
  requestId?: string
  environment?: {
    userAgent: string
    devicePixelRatio: number
    viewport: {
      innerWidth: number
      innerHeight: number
      outerWidth: number
      outerHeight: number
      visualViewportScale: number | null
    }
    screen: {
      width: number
      height: number
      availWidth: number
      availHeight: number
      colorDepth: number
      pixelDepth: number
    }
  }
  total?: number
  matchCount?: number
  mismatchCount?: number
  mismatches?: AccuracyMismatch[]
  rows?: AccuracyRow[]
  message?: string
}

const browser = (process.env['ACCURACY_CHECK_BROWSER'] ?? 'chrome').toLowerCase() as BrowserKind | 'firefox'
const includeFullRows = process.argv.includes('--full')
const reportTimeoutMs = Number.parseInt(
  process.env['ACCURACY_CHECK_TIMEOUT_MS'] ?? (browser === 'safari' ? '240000' : '120000'),
  10,
)

function parseStringFlag(name: string): string | null {
  const prefix = `--${name}=`
  const arg = process.argv.find(value => value.startsWith(prefix))
  return arg === undefined ? null : arg.slice(prefix.length)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function canReachServer(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl)
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await canReachServer(baseUrl)) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for local Bun server on ${baseUrl}`)
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const open = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port })
      let settled = false

      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }

      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
    if (open) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for local port ${port}`)
}

async function startProxyServer(targetOrigin: string): Promise<{ baseUrl: string, server: HttpServer }> {
  const port = await getAvailablePort()
  const server = createHttpServer(async (req, res) => {
    try {
      const targetUrl = new URL(req.url ?? '/', targetOrigin)
      const response = await fetch(targetUrl, { method: req.method ?? 'GET' })
      res.statusCode = response.status
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'transfer-encoding') return
        res.setHeader(key, value)
      })
      const body = response.body === null ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer())
      res.end(body)
    } catch (error) {
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(error instanceof Error ? error.message : String(error))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  return { baseUrl: `http://127.0.0.1:${port}/accuracy`, server }
}

async function startReportServer(expectedRequestId: string): Promise<{
  endpoint: string
  waitForReport: (timeoutMs?: number) => Promise<AccuracyReport>
  close: () => void
}> {
  const port = await getAvailablePort()
  let resolveReport: ((report: AccuracyReport) => void) | null = null
  let rejectReport: ((error: Error) => void) | null = null
  const reportPromise = new Promise<AccuracyReport>((resolve, reject) => {
    resolveReport = resolve
    rejectReport = reject
  })

  const server = createHttpServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
      res.statusCode = 204
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 404
      res.end()
      return
    }

    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      try {
        const report = JSON.parse(body) as AccuracyReport
        if (report.requestId === expectedRequestId) {
          resolveReport?.(report)
        }
        res.statusCode = 204
        res.end()
      } catch (error) {
        res.statusCode = 400
        res.end(error instanceof Error ? error.message : String(error))
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  return {
    endpoint: `http://127.0.0.1:${port}/report`,
    async waitForReport(timeoutMs = 120_000): Promise<AccuracyReport> {
      return await new Promise<AccuracyReport>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for posted accuracy report'))
        }, timeoutMs)

        reportPromise.then(
          report => {
            clearTimeout(timer)
            resolve(report)
          },
          error => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    },
    close() {
      server.close()
      rejectReport?.(new Error('Accuracy report server closed before report arrived'))
    },
  }
}

type BidiResponse = {
  id: number
  result?: unknown
  error?: string
  message?: string
  type?: string
}

async function connectFirefoxBidi(port: number): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<BidiResponse>
  close: () => void
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`)
  const pending = new Map<number, (message: BidiResponse) => void>()
  let nextId = 1

  ws.onmessage = event => {
    const message = JSON.parse(String(event.data)) as BidiResponse
    if (message.id === undefined) return
    const resolve = pending.get(message.id)
    if (resolve !== undefined) {
      pending.delete(message.id)
      resolve(message)
    }
  }

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = event => reject(new Error(String((event as ErrorEvent).message ?? 'Firefox WebSocket error')))
  })

  return {
    async send(method: string, params: Record<string, unknown> = {}): Promise<BidiResponse> {
      const id = nextId++
      ws.send(JSON.stringify({ id, method, params }))
      const message = await new Promise<BidiResponse>(resolve => pending.set(id, resolve))
      return message
    },
    close() {
      ws.close()
    },
  }
}

async function loadFirefoxReport(url: string, expectedRequestId: string): Promise<AccuracyReport> {
  const bidiPort = await getAvailablePort()
  const profileDir = mkdtempSync(join(tmpdir(), 'pretext-firefox-'))
  const firefoxProcess = spawn('/Applications/Firefox.app/Contents/MacOS/firefox', [
    '--headless',
    '--new-instance',
    '--profile',
    profileDir,
    '--remote-debugging-port',
    String(bidiPort),
    'about:blank',
  ], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })

  let bidi: Awaited<ReturnType<typeof connectFirefoxBidi>> | null = null

  try {
    await waitForPort(bidiPort)
    bidi = await connectFirefoxBidi(bidiPort)

    const session = await bidi.send('session.new', { capabilities: { alwaysMatch: {} } })
    if (session.error !== undefined) {
      throw new Error(session.message ?? session.error)
    }

    const tree = await bidi.send('browsingContext.getTree', {})
    if (tree.error !== undefined) {
      throw new Error(tree.message ?? tree.error)
    }

    const contexts = (tree.result as { contexts: Array<{ context: string }> }).contexts
    const context = contexts[0]?.context
    if (context === undefined) {
      throw new Error('Firefox BiDi returned no browsing context')
    }

    const navigate = await bidi.send('browsingContext.navigate', { context, url, wait: 'none' })
    if (navigate.error !== undefined) {
      throw new Error(navigate.message ?? navigate.error)
    }

    for (let i = 0; i < 1200; i++) {
      await sleep(100)
      const evaluation = await bidi.send('script.evaluate', {
        expression: `(() => {
          const el = document.getElementById('accuracy-report')
          return el && el.dataset.ready === '1' && el.textContent ? el.textContent : ''
        })()`,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      })

      if (evaluation.error !== undefined) {
        continue
      }

      const remoteResult = evaluation.result as {
        type: 'success'
        result: { type: string, value?: string }
      }
      const reportJson = remoteResult.result.value ?? ''
      if (reportJson === '' || reportJson === 'null') continue

      const report = JSON.parse(reportJson) as AccuracyReport
      if (report.requestId === expectedRequestId) {
        return report
      }
    }

    throw new Error('Timed out waiting for accuracy report from firefox')
  } finally {
    bidi?.close()
    firefoxProcess.kill('SIGTERM')
    rmSync(profileDir, { recursive: true, force: true })
  }
}

async function loadBrowserReport(url: string, expectedRequestId: string): Promise<AccuracyReport> {
  if (browser === 'firefox') {
    return await loadFirefoxReport(url, expectedRequestId)
  }
  const session = createBrowserSession(browser)
  try {
    return await loadHashReport<AccuracyReport>(session, url, expectedRequestId, browser, reportTimeoutMs)
  } finally {
    session.close()
  }
}

function formatDiff(diff: number): string {
  return `${diff > 0 ? '+' : ''}${Math.round(diff)}px`
}

function printReport(report: AccuracyReport): void {
  if (report.status === 'error') {
    console.log(`error: ${report.message ?? 'unknown error'}`)
    return
  }

  const total = report.total ?? 0
  const matchCount = report.matchCount ?? 0
  const mismatchCount = report.mismatchCount ?? 0
  const pct = total > 0 ? ((matchCount / total) * 100).toFixed(2) : '0.00'
  console.log(`${matchCount}/${total} match (${pct}%) | ${mismatchCount} mismatches`)
  if (report.environment !== undefined) {
    const env = report.environment
    console.log(
      `env: dpr ${env.devicePixelRatio} | viewport ${env.viewport.innerWidth}x${env.viewport.innerHeight} | outer ${env.viewport.outerWidth}x${env.viewport.outerHeight} | scale ${env.viewport.visualViewportScale ?? '-'} | screen ${env.screen.width}x${env.screen.height}`,
    )
  }

  for (const [index, mismatch] of (report.mismatches ?? []).entries()) {
    console.log(
      `${index + 1}. ${mismatch.label} | ${mismatch.fontSize}px ${mismatch.font} | w=${mismatch.width} | actual/predicted ${Math.round(mismatch.actual)}/${Math.round(mismatch.predicted)} | diff ${formatDiff(mismatch.diff)}`,
    )
    if (mismatch.diagnosticLines && mismatch.diagnosticLines.length > 0) {
      for (const line of mismatch.diagnosticLines) {
        console.log(`   ${line}`)
      }
    }
  }
}

let serverProcess: ChildProcess | null = null
let proxyServer: HttpServer | null = null
const lock = await acquireBrowserAutomationLock(browser)
const output = parseStringFlag('output')
const usePostedReport = includeFullRows && browser !== 'firefox'
const requestedPortRaw = process.env['ACCURACY_CHECK_PORT']
const requestedPort = (() => {
  if (requestedPortRaw === undefined) return null
  const parsed = Number.parseInt(requestedPortRaw, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ACCURACY_CHECK_PORT: ${requestedPortRaw}`)
  }
  return parsed
})()

try {
  let baseUrl: string

  if (browser === 'firefox') {
    const bunPort = await getAvailablePort()
    const bunBaseUrl = `http://localhost:${bunPort}/accuracy`
    serverProcess = spawn('/bin/zsh', ['-lc', `bun --port=${bunPort} --no-hmr pages/*.html`], {
      cwd: process.cwd(),
      stdio: 'ignore',
    })
    await waitForServer(bunBaseUrl)

    const proxy = await startProxyServer(`http://[::1]:${bunPort}`)
    proxyServer = proxy.server
    baseUrl = proxy.baseUrl
  } else {
    const port = await getAvailablePort(requestedPort)
    const pageServer = await ensurePageServer(port, '/accuracy', process.cwd())
    serverProcess = pageServer.process
    baseUrl = `${pageServer.baseUrl}/accuracy`
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let report: AccuracyReport

  if (usePostedReport) {
    const reportServer = await startReportServer(requestId)
    try {
      const session = createBrowserSession(browser)
      try {
        const url =
          `${baseUrl}?report=1&requestId=${requestId}` +
          `&full=1` +
          `&reportEndpoint=${encodeURIComponent(reportServer.endpoint)}`
        session.navigate(url)
        report = await reportServer.waitForReport(reportTimeoutMs)
      } finally {
        session.close()
      }
    } finally {
      reportServer.close()
    }
  } else {
    const url =
      `${baseUrl}?report=1&requestId=${requestId}` +
      `${includeFullRows ? '&full=1' : ''}`
    report = await loadBrowserReport(url, requestId)
  }

  printReport(report)
  if (output !== null) {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2))
    console.log(`wrote ${output}`)
  }
} finally {
  if (proxyServer !== null) {
    proxyServer.close()
  }
  if (serverProcess !== null) {
    serverProcess.kill('SIGTERM')
  }
  lock.release()
}
