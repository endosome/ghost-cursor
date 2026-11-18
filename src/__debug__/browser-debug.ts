import { type ClickOptions, GhostCursor } from '../spoof'
import { join } from 'path'
import { promises as fs } from 'fs'
import puppeteer from 'puppeteer'
import { chromium } from 'playwright-core'

// `yarn debug` uses Puppeteer, `DEBUG_BROWSER=playwright yarn debug` uses Playwright,
// `DEBUG_ALGORITHM=humancursor` switches the path algorithm.
const usePlaywright = process.env.DEBUG_BROWSER === 'playwright'
const algorithm = process.env.DEBUG_ALGORITHM === 'humancursor' ? 'humancursor' : 'ghost'

const launch = async (): Promise<{ page: any }> => {
  if (usePlaywright) {
    const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROME_PATH })
    return { page: await browser.newPage() }
  }
  const browser = await puppeteer.launch({ headless: false })
  return { page: await browser.newPage() }
}

const delay = async (ms: number): Promise<void> => {
  if (ms < 1) return
  return await new Promise((resolve) => setTimeout(resolve, ms))
}

const cursorDefaultOptions = {
  moveDelay: 100,
  moveSpeed: 99,
  hesitate: 100,
  waitForClick: 10,
  scrollDelay: 100,
  scrollSpeed: 40,
  inViewportMargin: 50,
  waitForSelector: 200,
  algorithm
} as const satisfies ClickOptions

launch().then(async ({ page }) => {
  const cursor = new GhostCursor(page, {
    visible: true,
    defaultOptions: {
      move: cursorDefaultOptions,
      moveTo: cursorDefaultOptions,
      click: cursorDefaultOptions,
      scroll: cursorDefaultOptions,
      getElement: cursorDefaultOptions
    }
  })

  const html = await fs.readFile(join(__dirname, 'custom-page.html'), 'utf8')

  await page.goto('data:text/html,' + encodeURIComponent(html), {
    waitUntil: usePlaywright ? 'networkidle' : 'networkidle2'
  })

  const performActions = async (): Promise<void> => {
    await cursor.click('#box1')

    await cursor.click('#box2')

    await cursor.removeMouseHelper()

    await cursor.click('#box3')

    await cursor.click('#box1')

    // await cursor.scrollTo('right')

    // await cursor.scrollTo('left')

    // await cursor.scrollTo('bottom')

    // await cursor.scrollTo('top')
  }

  await performActions()

  // allows us to hit "refresh" button to restart the events
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  page.on('load', async () => {
    await delay(500)
    await page.evaluate(() => { window.scrollTo(0, 0) })
    await delay(1000)

    await performActions()
  })
}).catch((e) => {
  console.error(e)
})
