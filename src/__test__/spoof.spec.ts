import type { Page } from 'puppeteer'
import { runSuite } from './suite'

declare const page: Page

runSuite('puppeteer', () => page)

jest.setTimeout(15_000)
