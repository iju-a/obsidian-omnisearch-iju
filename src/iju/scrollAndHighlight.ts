import { MarkdownView } from 'obsidian'
import { settings } from '../settings'

const SOURCE_HIGHLIGHT_DURATION_MS = 3600
const SOURCE_HIGHLIGHT_LAYER_CLASS = 'omnisearch-source-highlight-layer'
const SOURCE_HIGHLIGHT_RECT_CLASS = 'omnisearch-source-highlight-rect'

function waitForAnimationFrame(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => resolve())
  })
}

function waitForDelay(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

function ensureHighlightStyles(doc: Document): void {
  if (doc.getElementById('omnisearch-source-match-highlight-style')) {
    return
  }

  const styleEl = doc.createElement('style')
  styleEl.id = 'omnisearch-source-match-highlight-style'
  styleEl.textContent = `
    .${SOURCE_HIGHLIGHT_LAYER_CLASS} {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 5;
    }

    .${SOURCE_HIGHLIGHT_RECT_CLASS} {
      position: absolute;
      background-color: rgba(255, 208, 0, 0.6);
      border-radius: 3px;
      box-shadow: 0 0 0 1px rgba(255, 166, 0, 0.7);
      animation: omnisearch-source-match-fade ${SOURCE_HIGHLIGHT_DURATION_MS}ms linear forwards;
      will-change: opacity;
    }

    @keyframes omnisearch-source-match-fade {
      0% {
        opacity: 0.96;
      }

      100% {
        opacity: 0;
      }
    }
  `

  doc.head.appendChild(styleEl)
}

function getSourceEditorElements(view: MarkdownView): {
  editorEl: HTMLElement
  contentEl: HTMLElement
  scrollerEl: HTMLElement
} | null {
  const containerEl = (view as MarkdownView & { containerEl?: HTMLElement })
    .containerEl
  const editorEl = containerEl?.querySelector<HTMLElement>('.cm-editor')
  const contentEl = editorEl?.querySelector<HTMLElement>('.cm-content')
  const scrollerEl = editorEl?.querySelector<HTMLElement>('.cm-scroller')

  if (!editorEl || !contentEl || !scrollerEl) {
    return null
  }

  return { editorEl, contentEl, scrollerEl }
}

function getRenderedLineElement(
  contentEl: HTMLElement,
  targetLine: number,
  activeLine: number
): HTMLElement | null {
  const lineEls = contentEl.querySelectorAll<HTMLElement>('.cm-line')
  const activeIndex = Array.from(lineEls).findIndex(el =>
    el.hasClass('cm-active')
  )

  if (activeIndex === -1) {
    return null
  }

  const targetIndex = activeIndex + (targetLine - activeLine)
  return lineEls[targetIndex] ?? null
}

function locateTextPosition(
  root: HTMLElement,
  charOffset: number
): {
  node: Text
  offset: number
} | null {
  const doc = root.doc
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = charOffset
  let current = walker.nextNode()
  let lastTextNode: Text | null = null

  while (current) {
    if (current instanceof Text) {
      lastTextNode = current
      const length = current.textContent?.length ?? 0
      if (remaining <= length) {
        return { node: current, offset: remaining }
      }
      remaining -= length
    }
    current = walker.nextNode()
  }

  if (lastTextNode) {
    return {
      node: lastTextNode,
      offset: lastTextNode.textContent?.length ?? 0,
    }
  }

  return null
}

function getHighlightRectsFromTextNodes(
  root: HTMLElement,
  fromChar: number,
  toChar: number
): DOMRect[] {
  const rects: DOMRect[] = []
  const doc = root.doc
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  let currentOffset = 0

  while (current) {
    if (current instanceof Text) {
      const textLength = current.textContent?.length ?? 0
      const nodeStart = currentOffset
      const nodeEnd = currentOffset + textLength
      const overlapStart = Math.max(fromChar, nodeStart)
      const overlapEnd = Math.min(toChar, nodeEnd)

      if (overlapStart < overlapEnd) {
        const range = doc.createRange()
        range.setStart(current, overlapStart - nodeStart)
        range.setEnd(current, overlapEnd - nodeStart)
        rects.push(...Array.from(range.getClientRects()))
      }

      currentOffset = nodeEnd
    }

    current = walker.nextNode()
  }

  return rects
}

function getHighlightRectsFromVisibleMatch(
  root: HTMLElement,
  matchText: string
): DOMRect[] {
  const rects: DOMRect[] = []
  const doc = root.doc
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Array<{ node: Text; start: number; end: number }> = []
  let current = walker.nextNode()
  let visibleText = ''

  while (current) {
    if (current instanceof Text) {
      const text = current.textContent ?? ''
      const start = visibleText.length
      visibleText += text
      textNodes.push({
        node: current,
        start,
        end: visibleText.length,
      })
    }
    current = walker.nextNode()
  }

  const matchIndex = visibleText.indexOf(matchText)
  if (matchIndex === -1) {
    return rects
  }

  const matchEnd = matchIndex + matchText.length

  for (const segment of textNodes) {
    const overlapStart = Math.max(matchIndex, segment.start)
    const overlapEnd = Math.min(matchEnd, segment.end)

    if (overlapStart >= overlapEnd) {
      continue
    }

    const range = doc.createRange()
    range.setStart(segment.node, overlapStart - segment.start)
    range.setEnd(segment.node, overlapEnd - segment.start)
    rects.push(...Array.from(range.getClientRects()))
  }

  return rects
}

function pickBestHighlightRects(candidates: DOMRect[][]): DOMRect[] {
  return candidates.reduce<DOMRect[]>((best, current) => {
    if (current.length > best.length) {
      return current
    }
    if (current.length < best.length) {
      return best
    }

    const bestArea = best.reduce(
      (sum, rect) => sum + rect.width * rect.height,
      0
    )
    const currentArea = current.reduce(
      (sum, rect) => sum + rect.width * rect.height,
      0
    )

    return currentArea > bestArea ? current : best
  }, [])
}

function clearExistingHighlightLayer(editorEl: HTMLElement): void {
  const existingLayer = editorEl.querySelector<HTMLElement>(
    `.${SOURCE_HIGHLIGHT_LAYER_CLASS}`
  )
  existingLayer?.remove()

  const previousTimeout = Number(
    editorEl.dataset.omnisearchHighlightTimeout ?? 0
  )
  if (previousTimeout) {
    window.clearTimeout(previousTimeout)
    delete editorEl.dataset.omnisearchHighlightTimeout
  }
}

function createHighlightLayer(scrollerEl: HTMLElement): HTMLElement {
  const layerEl = scrollerEl.doc.createElement('div')
  layerEl.className = SOURCE_HIGHLIGHT_LAYER_CLASS
  scrollerEl.appendChild(layerEl)
  return layerEl
}

function addHighlightRects(
  layerEl: HTMLElement,
  scrollerEl: HTMLElement,
  rects: DOMRect[]
): boolean {
  const visibleRects = rects.filter(rect => rect.width > 0 && rect.height > 0)
  const scrollerRect = scrollerEl.getBoundingClientRect()

  for (const rect of visibleRects) {
    const rectEl = layerEl.doc.createElement('div')
    rectEl.className = SOURCE_HIGHLIGHT_RECT_CLASS
    rectEl.style.left = `${
      rect.left - scrollerRect.left + scrollerEl.scrollLeft
    }px`
    rectEl.style.top = `${rect.top - scrollerRect.top + scrollerEl.scrollTop}px`
    rectEl.style.width = `${rect.width}px`
    rectEl.style.height = `${rect.height}px`
    layerEl.appendChild(rectEl)
  }

  return visibleRects.length > 0
}

function getHighlightRectsFromEditorCoords(
  view: MarkdownView,
  offset: number,
  matchText: string
): DOMRect[] | null {
  const cm = (
    view.editor as {
      cm?: {
        coordsAtPos?: (
          pos: number
        ) => { left: number; right: number; top: number; bottom: number } | null
      }
    }
  ).cm

  const fromCoords = cm?.coordsAtPos?.(offset)
  const toCoords = cm?.coordsAtPos?.(offset + matchText.length)

  if (!fromCoords || !toCoords) {
    return null
  }

  const top = Math.min(fromCoords.top, toCoords.top)
  const bottom = Math.max(fromCoords.bottom, toCoords.bottom)
  const left = Math.min(fromCoords.left, toCoords.left)
  const right = Math.max(fromCoords.right, toCoords.right)
  const width = right - left
  const height = bottom - top

  if (width <= 0 || height <= 0) {
    return null
  }

  return [new DOMRect(left, top, width, height)]
}

function applySourceTextHighlight(
  view: MarkdownView,
  offset: number,
  matchText: string
): boolean {
  const editorElements = getSourceEditorElements(view)
  if (!editorElements) {
    return false
  }

  const { editorEl, contentEl, scrollerEl } = editorElements
  const from = view.editor.offsetToPos(offset)
  const to = view.editor.offsetToPos(offset + matchText.length)

  if (from.line !== to.line) {
    return false
  }

  const lineEl = getRenderedLineElement(contentEl, from.line, from.line)
  if (!lineEl) {
    return false
  }

  const rangeStart = locateTextPosition(lineEl, from.ch)
  const rangeEnd = locateTextPosition(lineEl, to.ch)

  if (!rangeStart || !rangeEnd) {
    return false
  }

  ensureHighlightStyles(editorEl.doc)
  clearExistingHighlightLayer(editorEl)
  const range = editorEl.doc.createRange()
  range.setStart(rangeStart.node, rangeStart.offset)
  range.setEnd(rangeEnd.node, rangeEnd.offset)
  const domRects = Array.from(range.getClientRects())
  const visibleMatchRects = getHighlightRectsFromVisibleMatch(lineEl, matchText)
  const nodeRects = getHighlightRectsFromTextNodes(lineEl, from.ch, to.ch)
  const cmRects = getHighlightRectsFromEditorCoords(view, offset, matchText)
  const rects = pickBestHighlightRects([
    visibleMatchRects,
    nodeRects,
    domRects,
    cmRects ?? [],
  ])

  const layerEl = createHighlightLayer(scrollerEl)
  const didRender = addHighlightRects(layerEl, scrollerEl, rects)

  if (!didRender) {
    layerEl.remove()
    return false
  }

  const timeout = window.setTimeout(() => {
    layerEl.remove()
    delete editorEl.dataset.omnisearchHighlightTimeout
  }, SOURCE_HIGHLIGHT_DURATION_MS)

  editorEl.dataset.omnisearchHighlightTimeout = String(timeout)
  return true
}

async function applySourceTextHighlightWithRetry(
  view: MarkdownView,
  offset: number,
  matchText: string,
  line: number
): Promise<void> {
  const attempts = 4

  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForAnimationFrame()
    await waitForDelay(50)

    if (applySourceTextHighlight(view, offset, matchText)) {
      return
    }
  }

  view.setEphemeralState({ line })
}

async function applyPreviewScrollWithRetry(
  view: MarkdownView,
  line: number
): Promise<void> {
  const attempts = 4
  const delayMs = 60

  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForAnimationFrame()
    await waitForAnimationFrame()
    await waitForDelay(delayMs)

    // Reading view renderer may require extra time before scroll/highlight is
    // applied reliably, especially in long documents or around callouts/footnotes.
    // Retry a few times instead of relying on a single frame boundary.

    //eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    ;(view?.previewMode as any).renderer?.applyScroll(line, {
      highlight: true,
      center: true,
    })
  }
}

export function scrollAndHighlight(
  view: MarkdownView,
  line: number,
  offset?: number,
  matchText?: string
) {
  if (!settings.highlightSearchTarget) {
    return
  }

  const nowMode = view.getMode()

  if (nowMode === 'source') {
    if (offset === undefined || !matchText?.length) {
      view.setEphemeralState({ line })
      return
    }

    void applySourceTextHighlightWithRetry(view, offset, matchText, line)
  } else if (nowMode === 'preview') {
    void applyPreviewScrollWithRetry(view, line)
  }
}
