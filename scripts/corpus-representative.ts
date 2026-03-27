import { mkdirSync, writeFileSync } from 'node:fs'
import { type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import {
  acquireBrowserAutomationLock,
  createBrowserSession,
  ensurePageServer,
  getAvailablePort,
  loadHashReport,
  type BrowserKind,
} from './browser-automation.ts'

type CorpusReport = {
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
  corpusId?: string
  title?: string
  language?: string
  direction?: string
  width?: number
  contentWidth?: number
  font?: string
  lineHeight?: number
  predictedHeight?: number
  actualHeight?: number
  diffPx?: number
  predictedLineCount?: number
  browserLineCount?: number
  message?: string
}

type RepresentativeRow = {
  corpusId: string
  title: string
  language: string
  direction: string
  width: number
  contentWidth: number
  font: string
  lineHeight: number
  predictedHeight: number
  actualHeight: number
  diffPx: number
  predictedLineCount: number
  browserLineCount: number
}

type BrowserSnapshot = {
  environment: NonNullable<CorpusReport['environment']>
  rows: RepresentativeRow[]
}

type CorpusRepresentativeSnapshot = {
  generatedAt: string
  corpora: string[]
  widths: number[]
  browsers: Partial<Record<BrowserKind, BrowserSnapshot>>
}

const CORPUS_IDS = [
  'mixed-app-text',
  'ja-kumo-no-ito',
  'ja-rashomon',
  'zh-guxiang',
  'zh-zhufu',
  'th-nithan-vetal-story-1',
  'my-cunning-heron-teacher',
  'my-bad-deeds-return-to-you-teacher',
  'ur-chughd',
] as const

const WIDTHS = [300, 600, 800] as const

function parseStringFlag(name: string): string | null {
  const prefix = `--${name}=`
  const arg = process.argv.find(value => value.startsWith(prefix))
  return arg === undefined ? null : arg.slice(prefix.length)
}

function parseNumberFlag(name: string, fallback: number): number {
  const raw = parseStringFlag(name)
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for --${name}: ${raw}`)
  }
  return parsed
}

function parseBrowsers(value: string | null): BrowserKind[] {
  if (value === null || value === 'all') return ['chrome', 'safari']
  if (value === 'chrome' || value === 'safari') return [value]
  throw new Error(`Unsupported --browser ${value}; expected chrome, safari, or all`)
}

function toRepresentativeRow(report: CorpusReport): RepresentativeRow {
  if (
    report.corpusId === undefined ||
    report.title === undefined ||
    report.language === undefined ||
    report.direction === undefined ||
    report.width === undefined ||
    report.contentWidth === undefined ||
    report.font === undefined ||
    report.lineHeight === undefined ||
    report.predictedHeight === undefined ||
    report.actualHeight === undefined ||
    report.diffPx === undefined ||
    report.predictedLineCount === undefined ||
    report.browserLineCount === undefined
  ) {
    throw new Error('Corpus report was missing representative snapshot fields')
  }

  return {
    corpusId: report.corpusId,
    title: report.title,
    language: report.language,
    direction: report.direction,
    width: report.width,
    contentWidth: report.contentWidth,
    font: report.font,
    lineHeight: report.lineHeight,
    predictedHeight: report.predictedHeight,
    actualHeight: report.actualHeight,
    diffPx: report.diffPx,
    predictedLineCount: report.predictedLineCount,
    browserLineCount: report.browserLineCount,
  }
}

const browsers = parseBrowsers(parseStringFlag('browser'))
const requestedPort = parseNumberFlag('port', Number.parseInt(process.env['CORPUS_CHECK_PORT'] ?? '0', 10))
const timeoutMs = parseNumberFlag('timeout', Number.parseInt(process.env['CORPUS_CHECK_TIMEOUT_MS'] ?? '180000', 10))
const output = parseStringFlag('output') ?? 'corpora/representative.json'

let serverProcess: ChildProcess | null = null

try {
  const port = await getAvailablePort(requestedPort === 0 ? null : requestedPort)
  const pageServer = await ensurePageServer(port, '/corpus', process.cwd())
  serverProcess = pageServer.process
  const baseUrl = `${pageServer.baseUrl}/corpus`

  const snapshot: CorpusRepresentativeSnapshot = {
    generatedAt: new Date().toISOString(),
    corpora: [...CORPUS_IDS],
    widths: [...WIDTHS],
    browsers: {},
  }

  for (const browser of browsers) {
    const lock = await acquireBrowserAutomationLock(browser)
    const session = createBrowserSession(browser)

    try {
      const rows: RepresentativeRow[] = []
      let environment: BrowserSnapshot['environment'] | null = null

      for (const corpusId of CORPUS_IDS) {
        for (const width of WIDTHS) {
          const requestId = `${Date.now()}-${browser}-${corpusId}-${width}-${Math.random().toString(36).slice(2)}`
          const url =
            `${baseUrl}?id=${encodeURIComponent(corpusId)}` +
            `&width=${width}` +
            `&report=1` +
            `&diagnostic=light` +
            `&requestId=${encodeURIComponent(requestId)}`

          const report = await loadHashReport<CorpusReport>(session, url, requestId, browser, timeoutMs)
          if (report.status === 'error') {
            throw new Error(report.message ?? `Corpus report failed for ${corpusId} @ ${width}`)
          }
          if (report.environment !== undefined) {
            environment = report.environment
          }
          rows.push(toRepresentativeRow(report))
        }
      }

      if (environment === null) {
        throw new Error(`Missing environment fingerprint for ${browser} representative snapshot`)
      }

      snapshot.browsers[browser] = {
        environment,
        rows,
      }
    } finally {
      session.close()
      lock.release()
    }
  }

  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(snapshot, null, 2), 'utf8')
  console.log(`wrote ${output}`)
} finally {
  serverProcess?.kill()
}
