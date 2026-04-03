import { MarkdownView } from 'obsidian'
import type { EditorPosition } from 'obsidian'
import { settings } from '../settings'

const SOURCE_HIGHLIGHT_FADE_DURATION_MS = 420
const SOURCE_HIGHLIGHT_INITIAL_ALPHA = 0.6
const SOURCE_CUSTOM_HIGHLIGHT_NAME = 'omnisearch-source-match'
const SOURCE_SELECTION_HIGHLIGHT_ACTIVE_CLASS =
  'omnisearch-source-selection-highlight-active'
const SOURCE_SELECTION_HIGHLIGHT_FADING_CLASS =
  'omnisearch-source-selection-highlight-fading'

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

function getHighlightDurationMs(): number {
  return Math.max(0, settings.highlightSearchTargetDurationMs ?? 3600)
}

function blurEditorWithinView(view: MarkdownView): void {
  const activeElement = view.containerEl.ownerDocument.activeElement
  if (!(activeElement instanceof HTMLElement)) {
    return
  }

  if (!view.containerEl.contains(activeElement)) {
    return
  }

  activeElement.blur()
}

function clearBrowserSelection(doc: Document): void {
  const selection = doc.getSelection()
  if (!selection) {
    return
  }

  if (typeof selection.removeAllRanges === 'function') {
    selection.removeAllRanges()
    return
  }

  if (typeof selection.empty === 'function') {
    selection.empty()
  }
}

function ensureHighlightStyles(doc: Document): void {
  if (doc.getElementById('omnisearch-source-match-highlight-style')) {
    return
  }

  const styleEl = doc.createElement('style')
  styleEl.id = 'omnisearch-source-match-highlight-style'
  styleEl.textContent = `
    ::highlight(${SOURCE_CUSTOM_HIGHLIGHT_NAME}) {
      background-color: rgba(
        255,
        208,
        0,
        var(--omnisearch-source-highlight-alpha, 0.6)
      );
      color: inherit;
    }

    .cm-editor.${SOURCE_SELECTION_HIGHLIGHT_ACTIVE_CLASS} > .cm-scroller > .cm-selectionLayer .cm-selectionBackground,
    .cm-editor.${SOURCE_SELECTION_HIGHLIGHT_ACTIVE_CLASS}.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground {
      background-color: rgba(
        255,
        208,
        0,
        var(--omnisearch-source-highlight-alpha, ${SOURCE_HIGHLIGHT_INITIAL_ALPHA})
      ) !important;
      border-radius: 3px;
      box-shadow: 0 0 0 1px rgba(255, 166, 0, 0.7);
    }

    .cm-editor.${SOURCE_SELECTION_HIGHLIGHT_ACTIVE_CLASS} {
      --omnisearch-source-highlight-alpha: ${SOURCE_HIGHLIGHT_INITIAL_ALPHA};
    }

    .cm-editor.${SOURCE_SELECTION_HIGHLIGHT_ACTIVE_CLASS}.${SOURCE_SELECTION_HIGHLIGHT_FADING_CLASS} {
      --omnisearch-source-highlight-alpha: 0;
    }
  `

  doc.head.appendChild(styleEl)
}

function getCssHighlights(doc: Document):
  | {
      delete(name: string): void
      set(name: string, value: unknown): void
    }
  | null {
  const cssWithHighlights = doc.defaultView?.CSS as
    | {
        highlights?: {
          delete(name: string): void
          set(name: string, value: unknown): void
        }
      }
    | undefined

  return cssWithHighlights?.highlights ?? null
}

function clearExistingCustomHighlight(doc: Document): void {
  getCssHighlights(doc)?.delete(SOURCE_CUSTOM_HIGHLIGHT_NAME)
}

function clearExistingSelectionHighlight(editorEl: HTMLElement): void {
  editorEl.removeClass(SOURCE_SELECTION_HIGHLIGHT_ACTIVE_CLASS)
  editorEl.removeClass(SOURCE_SELECTION_HIGHLIGHT_FADING_CLASS)
  clearExistingCustomHighlight(editorEl.doc)
  editorEl.style.removeProperty('--omnisearch-source-highlight-alpha')
  editorEl.doc.documentElement.style.removeProperty(
    '--omnisearch-source-highlight-alpha'
  )

  const previousTimeout = Number(
    editorEl.dataset.omnisearchSelectionHighlightTimeout ?? 0
  )
  if (previousTimeout) {
    window.clearTimeout(previousTimeout)
    delete editorEl.dataset.omnisearchSelectionHighlightTimeout
  }

  const previousFadeTimeout = Number(
    editorEl.dataset.omnisearchSelectionHighlightFadeTimeout ?? 0
  )
  if (previousFadeTimeout) {
    window.clearTimeout(previousFadeTimeout)
    delete editorEl.dataset.omnisearchSelectionHighlightFadeTimeout
  }

  const previousAnimationFrame = Number(
    editorEl.dataset.omnisearchSelectionHighlightAnimationFrame ?? 0
  )
  if (previousAnimationFrame) {
    cancelAnimationFrame(previousAnimationFrame)
    delete editorEl.dataset.omnisearchSelectionHighlightAnimationFrame
  }
}

function setHighlightAlpha(editorEl: HTMLElement, alpha: number): void {
  const value = String(Math.max(0, alpha))
  editorEl.style.setProperty('--omnisearch-source-highlight-alpha', value)
  editorEl.doc.documentElement.style.setProperty(
    '--omnisearch-source-highlight-alpha',
    value
  )
}

function startHighlightFade(editorEl: HTMLElement): void {
  // Drive the fade manually so the effect stays smooth even when the editor
  // DOM changes during Live Preview re-rendering.
  const start = performance.now()

  const tick = (now: number) => {
    const elapsed = now - start
    const progress = Math.min(elapsed / SOURCE_HIGHLIGHT_FADE_DURATION_MS, 1)
    const eased = 1 - (1 - progress) * (1 - progress)
    const alpha = SOURCE_HIGHLIGHT_INITIAL_ALPHA * (1 - eased)
    setHighlightAlpha(editorEl, alpha)

    if (progress < 1) {
      const animationFrame = requestAnimationFrame(tick)
      editorEl.dataset.omnisearchSelectionHighlightAnimationFrame =
        String(animationFrame)
      return
    }

    delete editorEl.dataset.omnisearchSelectionHighlightAnimationFrame
  }

  const animationFrame = requestAnimationFrame(tick)
  editorEl.dataset.omnisearchSelectionHighlightAnimationFrame =
    String(animationFrame)
}

function centerEditorRangeInScroller(
  scrollerEl: HTMLElement,
  range: Range | null
): void {
  if (!range) {
    return
  }

  const rangeRect = range.getBoundingClientRect()
  const scrollerRect = scrollerEl.getBoundingClientRect()

  if (!rangeRect.height && !rangeRect.width) {
    return
  }

  const rangeCenter =
    rangeRect.top - scrollerRect.top + scrollerEl.scrollTop + rangeRect.height / 2
  const targetScrollTop = Math.max(
    0,
    rangeCenter - scrollerEl.clientHeight / 2
  )

  scrollerEl.scrollTo({
    top: targetScrollTop,
    behavior: 'smooth',
  })
}

function centerElementInScroller(
  scrollerEl: HTMLElement,
  targetEl: HTMLElement
): void {
  const targetRect = targetEl.getBoundingClientRect()
  const scrollerRect = scrollerEl.getBoundingClientRect()

  if (!targetRect.height && !targetRect.width) {
    return
  }

  const targetCenter =
    targetRect.top -
    scrollerRect.top +
    scrollerEl.scrollTop +
    targetRect.height / 2

  const targetScrollTop = Math.max(
    0,
    targetCenter - scrollerEl.clientHeight / 2
  )

  scrollerEl.scrollTo({
    top: targetScrollTop,
    behavior: 'smooth',
  })
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

function findBestVisibleMatchRange(
  root: HTMLElement,
  matchText: string,
  preferredCenterY?: number
): Range | null {
  // After blur, Live Preview may rebuild the line DOM. Re-find the same visible
  // text in the new DOM and prefer the match that stayed closest to the
  // original screen position.
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

  let searchFrom = 0
  let bestRange: Range | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  while (searchFrom <= visibleText.length - matchText.length) {
    const matchIndex = visibleText.indexOf(matchText, searchFrom)
    if (matchIndex === -1) {
      break
    }

    const startSegment = textNodes.find(
      segment => matchIndex >= segment.start && matchIndex < segment.end
    )
    const endIndex = matchIndex + matchText.length
    const endSegment = textNodes.find(
      segment => endIndex > segment.start && endIndex <= segment.end
    )

    if (startSegment && endSegment) {
      const range = doc.createRange()
      range.setStart(startSegment.node, matchIndex - startSegment.start)
      range.setEnd(endSegment.node, endIndex - endSegment.start)

      if (preferredCenterY === undefined) {
        return range
      }

      const rect = range.getBoundingClientRect()
      const centerY = rect.top + rect.height / 2
      const distance = Math.abs(centerY - preferredCenterY)

      if (distance < bestDistance) {
        bestDistance = distance
        bestRange = range
      }
    }

    searchFrom = matchIndex + 1
  }

  return bestRange
}

function applyCssCustomHighlight(doc: Document, range: Range): boolean {
  const highlightCtor = doc.defaultView?.Highlight as
    | (new (...ranges: Range[]) => unknown)
    | undefined
  const highlights = getCssHighlights(doc)

  if (!highlightCtor || !highlights) {
    return false
  }

  clearExistingCustomHighlight(doc)
  highlights.set(SOURCE_CUSTOM_HIGHLIGHT_NAME, new highlightCtor(range))
  return true
}

export function scrollSourcePositionToCenter(
  view: MarkdownView,
  pos: EditorPosition
): boolean {
  const editorElements = getSourceEditorElements(view)
  if (!editorElements) {
    return false
  }

  const activeLine = view.editor.getCursor().line
  const targetLineEl = getRenderedLineElement(
    editorElements.contentEl,
    pos.line,
    activeLine
  )

  if (!targetLineEl) {
    return false
  }

  centerElementInScroller(editorElements.scrollerEl, targetLineEl)
  return true
}

async function applySourceSelectionHighlightWithRetry(
  view: MarkdownView,
  offset: number,
  matchText: string
): Promise<boolean> {
  if (!matchText.length) {
    return false
  }

  const editorElements = getSourceEditorElements(view)
  if (!editorElements) {
    return false
  }

  const { editorEl } = editorElements
  const highlightDurationMs = getHighlightDurationMs()
  const from = view.editor.offsetToPos(offset)
  const to = view.editor.offsetToPos(offset + matchText.length)
  ensureHighlightStyles(editorEl.doc)
  clearExistingSelectionHighlight(editorEl)
  setHighlightAlpha(editorEl, SOURCE_HIGHLIGHT_INITIAL_ALPHA)
  view.editor.setSelection(from, to)
  view.editor.focus()
  const attempts = 4

  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForAnimationFrame()
    await waitForDelay(50)

    const refreshedEditorElements = getSourceEditorElements(view)
    if (!refreshedEditorElements) {
      continue
    }

    const { editorEl: refreshedEditorEl } = refreshedEditorElements
    const selection = refreshedEditorEl.doc.getSelection()
    const selectedRange =
      selection && selection.rangeCount > 0
        ? selection.getRangeAt(0).cloneRange()
        : null

    if (selectedRange && applyCssCustomHighlight(refreshedEditorEl.doc, selectedRange)) {
      setHighlightAlpha(refreshedEditorEl, SOURCE_HIGHLIGHT_INITIAL_ALPHA)
      centerEditorRangeInScroller(refreshedEditorElements.scrollerEl, selectedRange)
      view.editor.setCursor(to)
      const selectedRect = selectedRange.getBoundingClientRect()
      const preferredCenterY = selectedRect.top + selectedRect.height / 2
      blurEditorWithinView(view)
      clearBrowserSelection(refreshedEditorEl.doc)

      let highlightEditorEl = refreshedEditorEl
      // Callouts and other folded syntax can rebuild immediately after blur.
      // Retry against the rebuilt DOM so the temporary highlight survives the
      // token-to-rendered transition.
      for (let rerenderAttempt = 0; rerenderAttempt < 6; rerenderAttempt++) {
        await waitForAnimationFrame()
        await waitForDelay(50)

        const rerenderedEditorElements = getSourceEditorElements(view)
        if (!rerenderedEditorElements) {
          continue
        }

        const rerenderedRange = findBestVisibleMatchRange(
          rerenderedEditorElements.contentEl,
          matchText,
          preferredCenterY
        )

        if (
          rerenderedRange &&
          applyCssCustomHighlight(
            rerenderedEditorElements.editorEl.doc,
            rerenderedRange
          )
        ) {
          highlightEditorEl = rerenderedEditorElements.editorEl
          setHighlightAlpha(highlightEditorEl, SOURCE_HIGHLIGHT_INITIAL_ALPHA)
          centerEditorRangeInScroller(
            rerenderedEditorElements.scrollerEl,
            rerenderedRange
          )
          break
        }
      }

      const fadeTimeout = window.setTimeout(() => {
        highlightEditorEl.addClass(SOURCE_SELECTION_HIGHLIGHT_FADING_CLASS)
        startHighlightFade(highlightEditorEl)
      }, Math.max(0, highlightDurationMs - SOURCE_HIGHLIGHT_FADE_DURATION_MS))

      const timeout = window.setTimeout(() => {
        clearExistingSelectionHighlight(highlightEditorEl)
      }, highlightDurationMs)

      highlightEditorEl.dataset.omnisearchSelectionHighlightTimeout = String(
        timeout
      )
      highlightEditorEl.dataset.omnisearchSelectionHighlightFadeTimeout =
        String(fadeTimeout)
      return true
    }

    const selectionBackgrounds = refreshedEditorEl.querySelectorAll<HTMLElement>(
      '.cm-scroller > .cm-selectionLayer .cm-selectionBackground'
    )

    if (!selectionBackgrounds.length) {
      continue
    }

    refreshedEditorEl.addClass(SOURCE_SELECTION_HIGHLIGHT_ACTIVE_CLASS)
    setHighlightAlpha(refreshedEditorEl, SOURCE_HIGHLIGHT_INITIAL_ALPHA)
    centerEditorRangeInScroller(refreshedEditorElements.scrollerEl, selectedRange)

    const fadeTimeout = window.setTimeout(() => {
      refreshedEditorEl.addClass(SOURCE_SELECTION_HIGHLIGHT_FADING_CLASS)
      startHighlightFade(refreshedEditorEl)
    }, Math.max(0, highlightDurationMs - SOURCE_HIGHLIGHT_FADE_DURATION_MS))

    const timeout = window.setTimeout(() => {
      clearExistingSelectionHighlight(refreshedEditorEl)
      view.editor.setCursor(to)
      blurEditorWithinView(view)
      clearBrowserSelection(refreshedEditorEl.doc)
    }, highlightDurationMs)

    refreshedEditorEl.dataset.omnisearchSelectionHighlightTimeout = String(
      timeout
    )
    refreshedEditorEl.dataset.omnisearchSelectionHighlightFadeTimeout = String(
      fadeTimeout
    )
    return true
  }

  clearExistingSelectionHighlight(editorEl)
  return false
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

export function highlightSearchTarget(
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
      return
    }

    void applySourceSelectionHighlightWithRetry(view, offset, matchText)
  } else if (nowMode === 'preview') {
    void applyPreviewScrollWithRetry(view, line)
  }
}
