import { layout, layoutNextLine, prepare, prepareWithSegments, type LayoutCursor, type LayoutLine, type PreparedTextWithSegments } from '../../src/layout.ts'

type DomCache = {
  editor: HTMLTextAreaElement
  summary: HTMLParagraphElement
  lines: HTMLOListElement
  segments: HTMLOListElement
}

type DemoState = {
  text: string
}

type PreparedInternals = PreparedTextWithSegments & {
  kinds: string[]
}

const INITIAL_TEXT =
  'AGI 春天到了. بدأت الرحلة 🚀 and the long URL is https://example.com/reports/q3?lang=ar&mode=full. ' +
  'Nora wrote "please keep 10\u202F000 rows visible," Mina replied "trans\u00ADatlantic labels are still weird."'

const domCache: DomCache = {
  editor: getRequiredTextarea('editor'),
  summary: getRequiredParagraph('summary'),
  lines: getRequiredList('lines'),
  segments: getRequiredList('segments'),
}

const st: DemoState = {
  text: INITIAL_TEXT,
}

let scheduledRaf: number | null = null
let lastEditorWidth = 0

domCache.editor.value = st.text
domCache.editor.addEventListener('input', () => {
  st.text = domCache.editor.value
  scheduleRender()
})

new ResizeObserver(entries => {
  const width = Math.round(entries[0]?.contentRect.width ?? 0)
  if (width === lastEditorWidth) return
  lastEditorWidth = width
  scheduleRender()
}).observe(domCache.editor)

document.fonts.ready.then(() => {
  scheduleRender()
})

window.addEventListener('resize', () => {
  scheduleRender()
})

scheduleRender()

function getRequiredTextarea(id: string): HTMLTextAreaElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredParagraph(id: string): HTMLParagraphElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLParagraphElement)) throw new Error(`#${id} not found`)
  return element
}

function getRequiredList(id: string): HTMLOListElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLOListElement)) throw new Error(`#${id} not found`)
  return element
}

function scheduleRender(): void {
  if (scheduledRaf !== null) return
  scheduledRaf = requestAnimationFrame(() => {
    scheduledRaf = null
    render()
  })
}

function parsePx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getFontFromStyles(styles: CSSStyleDeclaration): string {
  return styles.font.length > 0
    ? styles.font
    : `${styles.fontStyle} ${styles.fontVariant} ${styles.fontWeight} ${styles.fontSize} / ${styles.lineHeight} ${styles.fontFamily}`
}

function collectLines(prepared: PreparedTextWithSegments, width: number): LayoutLine[] {
  const lines: LayoutLine[] = []
  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }

  while (true) {
    const line = layoutNextLine(prepared, cursor, width)
    if (line === null) break
    lines.push(line)
    cursor = line.end
  }

  return lines
}

function render(): void {
  const styles = getComputedStyle(domCache.editor)
  lastEditorWidth = Math.round(domCache.editor.getBoundingClientRect().width)
  const font = getFontFromStyles(styles)
  const lineHeight = parsePx(styles.lineHeight)
  const paddingX = parsePx(styles.paddingLeft) + parsePx(styles.paddingRight)
  const paddingY = parsePx(styles.paddingTop) + parsePx(styles.paddingBottom)
  const borderY = parsePx(styles.borderTopWidth) + parsePx(styles.borderBottomWidth)
  const minHeight = parsePx(styles.minHeight)
  const contentWidth = Math.max(0, domCache.editor.clientWidth - paddingX)

  const prepared = prepare(st.text, font)
  const preparedRich = prepareWithSegments(st.text, font) as PreparedInternals
  const lines = collectLines(preparedRich, contentWidth)
  const contentHeight = Math.max(lineHeight, layout(prepared, contentWidth, lineHeight).height)
  const boxHeight = Math.max(minHeight, Math.ceil(contentHeight + paddingY + borderY))
  domCache.editor.style.height = `${boxHeight}px`

  domCache.summary.textContent =
    `content width: ${Math.round(contentWidth)}px\n` +
    `font: ${font}\n` +
    `line height: ${Math.round(lineHeight)}px\n` +
    `content height: ${Math.round(contentHeight)}px\n` +
    `textarea box height: ${Math.round(boxHeight)}px\n` +
    `line count: ${lines.length}`

  renderLines(lines)
  renderSegments(preparedRich)
}

function renderLines(lines: LayoutLine[]): void {
  domCache.lines.textContent = ''
  const fragment = document.createDocumentFragment()

  for (const [index, line] of lines.entries()) {
    const item = document.createElement('li')
    const meta = document.createElement('span')
    meta.className = 'row-meta'
    meta.textContent =
      `L${index + 1} · ${line.width.toFixed(2)}px · ` +
      `${line.start.segmentIndex}:${line.start.graphemeIndex} → ${line.end.segmentIndex}:${line.end.graphemeIndex}`

    const text = document.createElement('code')
    text.textContent = line.text
    item.append(meta, text)
    fragment.append(item)
  }

  domCache.lines.append(fragment)
}

function renderSegments(prepared: PreparedInternals): void {
  domCache.segments.textContent = ''
  const fragment = document.createDocumentFragment()

  for (let index = 0; index < prepared.segments.length; index++) {
    const item = document.createElement('li')
    const meta = document.createElement('span')
    meta.className = 'row-meta'
    meta.textContent = `#${index} · ${prepared.kinds[index] ?? 'text'}`

    const text = document.createElement('code')
    text.textContent = JSON.stringify(prepared.segments[index])
    item.append(meta, text)
    fragment.append(item)
  }

  domCache.segments.append(fragment)
}
