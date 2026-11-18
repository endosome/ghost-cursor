/**
 * Thin abstraction over the automation library so ghost-cursor works with both
 * Puppeteer and Playwright pages.
 *
 * - Puppeteer pages keep using CDP directly (as ghost-cursor always has).
 * - Playwright pages use Playwright's public, browser-agnostic APIs
 *   (`page.mouse`, `addInitScript`, `scrollIntoViewIfNeeded`, ...), so they also
 *   work with Firefox and WebKit.
 */
import type * as Puppeteer from 'puppeteer'
import type * as Playwright from 'playwright-core'

export type PuppeteerPage = Puppeteer.Page
export type PlaywrightPage = Playwright.Page
export type Page = PuppeteerPage | PlaywrightPage

export type PuppeteerElementHandle<T extends Node = Element> = Puppeteer.ElementHandle<T>
export type PlaywrightElementHandle<T extends Node = Element> = Playwright.ElementHandle<T>
export type ElementHandle<T extends Node = Element> = PuppeteerElementHandle<T> | PlaywrightElementHandle<T>
export type Locator = Playwright.Locator

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export type MouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'

export const isPlaywrightPage = (page: Page): page is PlaywrightPage =>
  typeof (page as any).addInitScript === 'function' && typeof (page as any).context === 'function'

export const isPuppeteerPage = (page: Page): page is PuppeteerPage => !isPlaywrightPage(page)

export const isElementHandle = (item: any): item is ElementHandle =>
  item !== null && item !== undefined && typeof item.asElement === 'function'

/** Playwright `Locator` (has `elementHandle` and `first`, but no `asElement`). */
export const isPlaywrightLocator = (item: any): item is Locator =>
  item !== null && item !== undefined &&
  typeof item.elementHandle === 'function' &&
  typeof item.first === 'function' &&
  typeof item.asElement !== 'function'

/** The function signature to access the internal CDP client changed in puppeteer 14.4.1 */
export const getCDPClient = (page: PuppeteerPage): Puppeteer.CDPSession =>
  typeof (page as any)._client === 'function'
    ? (page as any)._client()
    : (page as any)._client

export interface MouseDriver {
  move: (x: number, y: number, timestamp?: number) => Promise<void>
  button: (action: 'down' | 'up', x: number, y: number, button: MouseButton, clickCount: number) => Promise<void>
  wheel: (x: number, y: number, deltaX: number, deltaY: number) => Promise<void>
}

const playwrightMousePositions = new WeakMap<PlaywrightPage, { x: number, y: number }>()

export const getMouseDriver = (page: Page): MouseDriver => {
  if (isPlaywrightPage(page)) {
    const toPwButton = (b: MouseButton): 'left' | 'right' | 'middle' =>
      b === 'right' || b === 'middle' ? b : 'left'
    const move = async (x: number, y: number): Promise<void> => {
      await page.mouse.move(x, y)
      playwrightMousePositions.set(page, { x, y })
    }
    // Playwright tracks the mouse position itself and dispatches buttons/wheel there.
    // Make sure it matches ours, without an extra round-trip when it already does.
    const syncPosition = async (x: number, y: number): Promise<void> => {
      const last = playwrightMousePositions.get(page)
      if (last?.x !== x || last?.y !== y) await move(x, y)
    }
    return {
      move,
      button: async (action, x, y, button, clickCount) => {
        await syncPosition(x, y)
        const opts = { button: toPwButton(button), clickCount }
        if (action === 'down') await page.mouse.down(opts)
        else await page.mouse.up(opts)
      },
      wheel: async (x, y, deltaX, deltaY) => {
        await syncPosition(x, y)
        await page.mouse.wheel(deltaX, deltaY)
      }
    }
  }

  const cdp = (): Puppeteer.CDPSession => getCDPClient(page)
  return {
    move: async (x, y, timestamp) => {
      const params: Puppeteer.Protocol.Input.DispatchMouseEventRequest = { type: 'mouseMoved', x, y }
      if (timestamp !== undefined) params.timestamp = timestamp
      await cdp().send('Input.dispatchMouseEvent', params)
    },
    button: async (action, x, y, button, clickCount) => {
      await cdp().send('Input.dispatchMouseEvent', {
        type: action === 'down' ? 'mousePressed' : 'mouseReleased',
        x,
        y,
        button,
        clickCount
      })
    },
    wheel: async (x, y, deltaX, deltaY) => {
      await cdp().send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
    }
  }
}

/** Whether the page/browser can still receive input. */
export const isPageConnected = (page: Page): boolean => {
  if (isPlaywrightPage(page)) return !page.isClosed()
  // `connected` exists since puppeteer 22 (where `isConnected()` was removed); older versions only have `isConnected()`.
  const browser: any = page.browser()
  if (typeof browser.connected === 'boolean') return browser.connected
  return typeof browser.isConnected === 'function' ? browser.isConnected() : true
}

/** Size of the browser window (Puppeteer) or viewport (Playwright). */
export const getWindowSize = async (page: Page): Promise<{ width: number, height: number }> => {
  if (isPlaywrightPage(page)) {
    const vp = page.viewportSize()
    if (vp !== null) return vp
    return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  }
  const targetId: string = (page.target() as any)._targetId
  const { bounds } = await getCDPClient(page).send('Browser.getWindowForTarget', { targetId })
  return { width: bounds.width ?? 0, height: bounds.height ?? 0 }
}

/**
 * Precise box of an element from its content quads (handles inline elements like `<a>`).
 * Puppeteer only; returns `null` when unavailable so callers can fall back.
 */
export const getContentQuadsBox = async (page: Page, element: ElementHandle): Promise<BoundingBox | null> => {
  if (isPlaywrightPage(page)) return null
  const objectId = (element as PuppeteerElementHandle).remoteObject().objectId
  if (objectId === undefined) return null
  const { quads } = await getCDPClient(page).send('DOM.getContentQuads', { objectId })
  if (quads.length === 0) return null
  return {
    x: quads[0][0],
    y: quads[0][1],
    width: quads[0][4] - quads[0][0],
    height: quads[0][5] - quads[0][1]
  }
}

/** Instantly scroll the element into view if it isn't already. */
export const scrollIntoViewIfNeeded = async (page: Page, element: ElementHandle): Promise<void> => {
  if (isPlaywrightPage(page)) {
    await (element as PlaywrightElementHandle).scrollIntoViewIfNeeded()
    return
  }
  const objectId = (element as PuppeteerElementHandle).remoteObject().objectId
  if (objectId === undefined) throw new Error('Element objectId is undefined')
  await getCDPClient(page).send('DOM.scrollIntoViewIfNeeded', { objectId })
}

/** Query a single element by CSS selector or XPath (starting with `//` or `(//`). */
export const querySelector = async (
  page: Page,
  selector: string,
  waitForSelector?: number
): Promise<ElementHandle | null> => {
  const isXPath = selector.startsWith('//') || selector.startsWith('(//')

  if (isPlaywrightPage(page)) {
    const pwSelector = isXPath ? `xpath=${selector}` : selector
    if (waitForSelector !== undefined) {
      await page.waitForSelector(pwSelector, { timeout: waitForSelector, state: 'attached' })
    }
    return await page.$(pwSelector)
  }

  const ppSelector = isXPath ? `xpath/.${selector}` : selector
  if (waitForSelector !== undefined) {
    await page.waitForSelector(ppSelector, { timeout: waitForSelector })
  }
  if (!isXPath) return await page.$(ppSelector)
  const [handle] = await page.$$(ppSelector)
  return (handle?.asElement() as PuppeteerElementHandle | null | undefined) ?? null
}

/** Inject a script into every new document. Returns a function that stops injecting it. */
export const addInitScript = async (page: Page, fn: () => void): Promise<() => Promise<void>> => {
  if (isPlaywrightPage(page)) {
    const disposable: any = await page.addInitScript(fn)
    // Playwright >= 1.56 returns a Disposable; older versions can't remove init scripts.
    return async () => { await disposable?.dispose?.() }
  }
  const { identifier } = await page.evaluateOnNewDocument(fn)
  return async () => { await page.removeScriptToEvaluateOnNewDocument(identifier) }
}
