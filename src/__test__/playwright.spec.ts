import { chromium, type Browser, type Page } from 'playwright-core'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { runSuite } from './suite'

/**
 * Reuse the Chrome binary puppeteer downloads so no extra Playwright browser download is needed.
 * Override with CHROME_PATH.
 */
const findChrome = (): string | undefined => {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const cacheDir = join(process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), '.cache', 'puppeteer'), 'chrome')
  if (!existsSync(cacheDir)) return undefined
  const candidates = readdirSync(cacheDir).sort().reverse().flatMap((version) => [
    join(cacheDir, version, 'chrome-linux64', 'chrome'),
    join(cacheDir, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(cacheDir, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(cacheDir, version, 'chrome-win64', 'chrome.exe')
  ])
  return candidates.find((c) => existsSync(c))
}

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
})

afterAll(async () => {
  await browser?.close()
})

runSuite('playwright', () => page)

jest.setTimeout(15_000)
