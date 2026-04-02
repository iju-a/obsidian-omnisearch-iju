import { App, MarkdownView } from 'obsidian'

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

export function scrollAndHighlight(view: MarkdownView, line: number) {
  const nowMode = view.getMode()

  if (nowMode === 'source') {
    view.setEphemeralState({ line })
  } else if (nowMode === 'preview') {
    // reading view mode
    void applyPreviewScrollWithRetry(view, line)
  }
}
