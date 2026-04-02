import { App, MarkdownView } from 'obsidian'

export function scrollAndHighlight(view: MarkdownView, line: number) {
  const nowMode = view.getMode()

  if (nowMode === 'source') {
    view.setEphemeralState({ line })
  } else if (nowMode === 'preview') {
    //reading view mode
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Reading view renderer may require one or more animation frames before
        // scroll/highlight is applied reliably, especially around callouts/footnotes.
        // This is a best-effort approach and may still produce imperfect highlighting.

        //eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        ;(view?.previewMode as any).renderer.applyScroll(line, {
          highlight: true,
          center: true,
        })
      })
    })
  }
}
