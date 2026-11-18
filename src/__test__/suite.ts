import { type ClickOptions, type ElementHandle, type Page, GhostCursor, isPlaywrightPage } from '../spoof'
import { join } from 'path'
import { readFileSync } from 'fs'
import { installMouseHelper } from '../mouse-helper'

const cursorDefaultOptions = {
  moveDelay: 0,
  moveSpeed: 99,
  hesitate: 0,
  waitForClick: 0,
  scrollDelay: 0,
  scrollSpeed: 99,
  inViewportMargin: 50
} as const satisfies ClickOptions

declare global {
  // eslint-disable-next-line no-var
  var boxWasClicked: boolean
}

/** Runs the shared test-suite against a Puppeteer or Playwright page. */
export const runSuite = (name: string, getPage: () => Page): void => describe(`Mouse movements (${name})`, () => {
  let cursor: GhostCursor
  let page: any

  const waitForSelector = async (selector: string): Promise<ElementHandle> => {
    const box = await page.waitForSelector(selector, isPlaywrightPage(page) ? { state: 'attached' } : undefined)
    if (box == null) throw new Error(`${selector} not found`)
    return box
  }

  const isIntersectingViewport = async (elem: ElementHandle): Promise<boolean> =>
    (elem as any).evaluate((el: Element) => {
      const r = el.getBoundingClientRect()
      return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
    })

  const html = readFileSync(join(__dirname, 'custom-page.html'), 'utf8')

  beforeAll(async () => {
    page = getPage()
    await installMouseHelper(page)
  })

  beforeEach(async () => {
    await page.goto('data:text/html,' + encodeURIComponent(html), {
      waitUntil: isPlaywrightPage(page) ? 'networkidle' : 'networkidle2'
    })

    cursor = new GhostCursor(page, {
      defaultOptions: {
        move: cursorDefaultOptions,
        click: cursorDefaultOptions,
        moveTo: cursorDefaultOptions
      }
    })
  })

  const testClick = async (clickSelector: string): Promise<void> => {
    // custom-page.html moves #box1 after 1s; don't race that relayout between mousedown and mouseup.
    await page.waitForFunction(() => performance.now() > 1100)
    expect(await page.evaluate(() => window.boxWasClicked)).toEqual(false)
    await cursor.click(clickSelector)
    expect(await page.evaluate(() => window.boxWasClicked)).toEqual(true)
  }

  const getScrollPosition = async (): Promise<{ top: number, left: number }> => page.evaluate(() => (
    { top: window.scrollY, left: window.scrollX }
  ))

  it('Should click on the element without throwing an error (CSS selector)', async () => {
    await testClick('#box1')
  })

  it('Should click on the element without throwing an error (XPath selector)', async () => {
    await testClick('//*[@id="box1"]')
  })

  it('Should click on a Playwright Locator (playwright only)', async () => {
    if (!isPlaywrightPage(page)) return
    expect(await page.evaluate(() => window.boxWasClicked)).toEqual(false)
    await cursor.click(page.locator('#box1'))
    expect(await page.evaluate(() => window.boxWasClicked)).toEqual(true)
  })

  it('Should scroll to elements correctly', async () => {
    const boxes = await Promise.all([1, 2, 3].map(async (n) => await waitForSelector(`#box${n}`)))

    expect(await getScrollPosition()).toEqual({ top: 0, left: 0 })

    expect(await isIntersectingViewport(boxes[0])).toBeTruthy()
    await cursor.click(boxes[0])
    expect(await getScrollPosition()).toEqual({ top: 0, left: 0 })
    expect(await isIntersectingViewport(boxes[0])).toBeTruthy()

    expect(await isIntersectingViewport(boxes[1])).toBeFalsy()
    await cursor.move(boxes[1])
    expect(await getScrollPosition()).toEqual({ top: 2500, left: 0 })
    expect(await isIntersectingViewport(boxes[1])).toBeTruthy()

    expect(await isIntersectingViewport(boxes[2])).toBeFalsy()
    await cursor.move(boxes[2])
    expect(await getScrollPosition()).toEqual({ top: 4450, left: 2250 })
    expect(await isIntersectingViewport(boxes[2])).toBeTruthy()

    expect(await isIntersectingViewport(boxes[0])).toBeFalsy()
    await cursor.click(boxes[0])
    expect(await isIntersectingViewport(boxes[0])).toBeTruthy()
  })

  it('Should scroll to position correctly', async () => {
    expect(await getScrollPosition()).toEqual({ top: 0, left: 0 })

    await cursor.scrollTo('bottom')
    expect(await getScrollPosition()).toEqual({ top: 4450, left: 0 })

    await cursor.scrollTo('right')
    expect(await getScrollPosition()).toEqual({ top: 4450, left: 2250 })

    await cursor.scrollTo('top')
    expect(await getScrollPosition()).toEqual({ top: 0, left: 2250 })

    await cursor.scrollTo('left')
    expect(await getScrollPosition()).toEqual({ top: 0, left: 0 })

    await cursor.scrollTo({ y: 200, x: 400 })
    expect(await getScrollPosition()).toEqual({ top: 200, left: 400 })
  })

  it('Should scroll to an ElementHandle correctly from a non-zero scroll position', async () => {
    const box2 = await waitForSelector('#box2')

    // Start from a non-zero scroll position so that boundingBox() returns
    // viewport-relative coords that differ from document-relative coords.
    await cursor.scrollTo({ y: 1000 })
    expect(await getScrollPosition()).toEqual({ top: 1000, left: 0 })
    expect(await isIntersectingViewport(box2)).toBeFalsy()

    await cursor.scrollTo(box2)
    expect(await isIntersectingViewport(box2)).toBeTruthy()
  })
})
