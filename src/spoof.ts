import {
  type ElementHandle,
  type Page,
  type BoundingBox,
  type Locator,
  type MouseButton,
  getCDPClient,
  getContentQuadsBox,
  getMouseDriver,
  getWindowSize,
  isElementHandle,
  isPageConnected,
  isPlaywrightLocator,
  isPlaywrightPage,
  querySelector,
  scrollIntoViewIfNeeded
} from './driver'
import debug from 'debug'
import {
  type Vector,
  type TimedVector,
  bezierCurve,
  direction,
  magnitude,
  origin,
  overshoot,
  add,
  clamp,
  scale,
  isFiniteVector,
  secureMathRandom
} from './math'
import { installMouseHelper } from './mouse-helper'
import { HumanizeMouseTrajectory } from './human-curve-generator'
import { generateRandomCurveParameters } from './calculate-and-randomize'

// TODO: remove in next major version, is now wrapped in the GhostCursor class.
export { installMouseHelper }
export { getCDPClient, isPlaywrightPage }
export type { Page, ElementHandle, Locator, BoundingBox, MouseButton } from './driver'

const log = debug('ghost-cursor')

/** Upper bounds so absurd inputs (huge distances, tiny speeds) can't freeze the cursor. */
const MAX_PATH_STEPS = 10000
const MAX_SCROLL_STEPS = 5000

/**
 * Path generation algorithm.
 * - `ghost`: ghost-cursor's original Bezier curve with Fitts's-law timing and overshoot.
 * - `humancursor`: port of the Python `humancursor` library (multi-knot Bezier curves with
 *   distortion and tweening, no overshoot, targets the central 20-80% of elements).
 */
export type PathAlgorithm = 'ghost' | 'humancursor'

/** A fixed delay in ms, or a `[min, max]` range a random delay is picked from. */
export type DelayValue = number | readonly [number, number]

export interface BoxOptions {
  /**
   * Percentage of padding to be added inside the element when determining the target point.
   * Example:
   * - `0` = may be anywhere within the element.
   * - `100` = will always be center of element.
   * @default 0
   */
  readonly paddingPercentage?: number
  /**
   * Destination to move the cursor to, relative to the top-left corner of the element.
   * If specified, `paddingPercentage` is not used.
   * If not specified (default), destination is random point within the `paddingPercentage`.
   * @default undefined (random point)
   */
  readonly destination?: Vector
}

export interface GetElementOptions {
  /**
   * Time to wait for the selector to appear in milliseconds.
   * Default is to not wait for selector.
   */
  readonly waitForSelector?: number
}

type PagePosition = 'top' | 'bottom' | 'left' | 'right'
export type ScrollToDestination = Partial<Vector> | PagePosition | ElementHandle | Locator

export interface ScrollOptions {
  /**
   * Scroll speed. 0 to 100. 100 is instant.
   * @default 100
   */
  readonly scrollSpeed?: number
  /**
   * How wheel events are generated.
   * - `steps`: evenly sized wheel steps, `scrollSpeed` px each (instant at 100).
   * - `momentum`: a stream of wheel events with ease-out-cubic momentum (fast start, slow finish),
   *   ~16ms apart with jitter. `scrollSpeed` sets the duration (100 = 300ms, 1 = 2000ms).
   * @default "steps"
   */
  readonly scrollMode?: 'steps' | 'momentum'
  /**
   * Time to wait after scrolling.
   * @default 200
   */
  readonly scrollDelay?: number
}

export interface ScrollIntoViewOptions extends ScrollOptions, GetElementOptions {
  /**
   * Scroll speed (when scrolling occurs). 0 to 100. 100 is instant.
   * @default 100
   */
  readonly scrollSpeed?: number
  /**
   * Time to wait after scrolling (when scrolling occurs).
   * @default 200
   */
  readonly scrollDelay?: number
  /**
   * Margin (in px) to add around the element when ensuring it is in the viewport.
   * (Does not take effect if CDP scroll fails.)
   * @default 0
   */
  readonly inViewportMargin?: number
  /**
   * Add a random over/under-scroll of up to ±10% of the scroll distance (max ±50px), like a human
   * who doesn't scroll perfectly. Also disables the instant `scrollIntoViewIfNeeded` shortcut so
   * scrolling always happens through wheel events.
   * @default false
   */
  readonly randomScrollPadding?: boolean
}

export interface MoveOptions extends BoxOptions, ScrollIntoViewOptions, Pick<PathOptions, 'moveSpeed' | 'algorithm'> {
  /**
   * Delay after moving the mouse in milliseconds. If `randomizeMoveDelay=true`, delay is randomized from 0 to `moveDelay`.
   * @default 0
   */
  readonly moveDelay?: number
  /**
   * Randomize delay between actions from `0` to `moveDelay`. See `moveDelay` docs.
   * @default true
   */
  readonly randomizeMoveDelay?: boolean
  /**
   * Maximum number of attempts to mouse-over the element.
   * @default 10
   */
  readonly maxTries?: number
  /**
   * Distance from current location to destination that triggers overshoot to
   * occur. (Below this distance, no overshoot will occur).
   * @default 500
   */
  readonly overshootThreshold?: number
  /**
   * Don't move when the cursor is already inside the element (and no `destination` is set),
   * or already within 5px of the destination. Avoids needless zig-zagging.
   * @default false (true when `algorithm` is "humancursor")
   */
  readonly skipMoveIfClose?: boolean
}

export interface ClickOptions extends MoveOptions {
  /**
   * Delay before initiating the click action in milliseconds.
   * @default 0
   */
  readonly hesitate?: number
  /**
   * Delay between mousedown and mouseup in milliseconds.
   * Can be a `[min, max]` range to pick a random delay, e.g. `[40, 60]`.
   * @default 0
   */
  readonly waitForClick?: DelayValue
  /**
   * @default 2000
   */
  readonly moveDelay?: number
  /**
   * @default "left"
   */
  readonly button?: MouseButton
  /**
   * @default 1
   */
  readonly clickCount?: number
}

export interface PathOptions {
  /**
   * Override the spread of the generated path.
   */
  readonly spreadOverride?: number
  /**
   * Speed of mouse movement.
   * Default is random.
   */
  readonly moveSpeed?: number

  /**
   * Generate timestamps for each point in the path.
   */
  readonly useTimestamps?: boolean
  /**
   * Path generation algorithm. See {@link PathAlgorithm}.
   * @default "ghost"
   */
  readonly algorithm?: PathAlgorithm
}

export interface RandomMoveOptions extends Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay' | 'moveSpeed' | 'algorithm'> {
  /**
   * @default 2000
   */
  readonly moveDelay?: number
}

export interface MoveToOptions extends PathOptions, Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay' | 'skipMoveIfClose'> {
  /**
   * @default 0
   */
  readonly moveDelay?: number
}

export type MouseButtonOptions = Pick<ClickOptions, 'button' | 'clickCount'>

/**
 * Default options for cursor functions.
 */
export interface DefaultOptions {
  /**
   * Default options for the `randomMove` function that occurs when `performRandomMoves=true`
   * @default RandomMoveOptions
   */
  randomMove?: RandomMoveOptions
  /**
   * Default options for the `move` function
   * @default MoveOptions
   */
  move?: MoveOptions
  /**
   * Default options for the `moveTo` function
   * @default MoveToOptions
   */
  moveTo?: MoveToOptions
  /**
   * Default options for the `click` function
   * @default ClickOptions
   */
  click?: ClickOptions
  /**
  * Default options for the `scrollIntoView`, `scrollTo`, and `scroll` functions
  * @default ScrollIntoViewOptions
  */
  scroll?: ScrollOptions & ScrollIntoViewOptions
  /**
   * Default options for the `getElement` function
   * @default GetElementOptions
   */
  getElement?: GetElementOptions
}

/** Helper function to wait a specified number of milliseconds  */
const delay = async (ms: number): Promise<void> => {
  if (ms < 1) return
  return await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calculate the amount of time needed to move from (x1, y1) to (x2, y2)
 * given the width of the element being clicked on
 * https://en.wikipedia.org/wiki/Fitts%27s_law
 */
const fitts = (distance: number, width: number): number =>
  2 * Math.log2(distance / width + 1)

const resolveDelay = (value: DelayValue): number =>
  typeof value === 'number' ? value : value[0] + secureMathRandom() * (value[1] - value[0])

/** Get a random point on a box */
const getRandomBoxPoint = (
  { x, y, width, height }: BoundingBox,
  options?: Pick<BoxOptions, 'paddingPercentage'> & Pick<PathOptions, 'algorithm'>
): Vector => {
  if (options?.algorithm === 'humancursor' && options.paddingPercentage === undefined) {
    // humancursor picks an integer percentage in [20, 79] on each axis, avoiding the edges.
    return {
      x: x + width * (Math.floor(secureMathRandom() * 60) + 20) / 100,
      y: y + height * (Math.floor(secureMathRandom() * 60) + 20) / 100
    }
  }

  let paddingWidth = 0
  let paddingHeight = 0

  if (
    options?.paddingPercentage !== undefined &&
    options?.paddingPercentage > 0 &&
    options?.paddingPercentage <= 100
  ) {
    paddingWidth = (width * options.paddingPercentage) / 100
    paddingHeight = (height * options.paddingPercentage) / 100
  }

  return {
    x: x + paddingWidth / 2 + secureMathRandom() * (width - paddingWidth),
    y: y + paddingHeight / 2 + secureMathRandom() * (height - paddingHeight)
  }
}

/** Get a random point on a browser window */
export const getRandomPagePoint = async (page: Page): Promise<Vector> => {
  const { width, height } = await getWindowSize(page)
  return getRandomBoxPoint({ x: origin.x, y: origin.y, width, height })
}

/** Get correct position of Inline elements (elements like `<a>`). Has fallback. */
export const getElementBox = async (
  page: Page,
  element: ElementHandle,
  relativeToMainFrame: boolean = true): Promise<BoundingBox> => {
  try {
    const elementBox = await getContentQuadsBox(page, element)
    if (elementBox === null) throw new Error('Content quads unavailable, falling back to alternative methods')
    if (!relativeToMainFrame) {
      // Only reached for Puppeteer (getContentQuadsBox returns null for Playwright).
      const elementFrame = await (element as any).contentFrame()
      const iframes: any[] | undefined = await elementFrame?.parentFrame()?.$$('xpath/.//iframe')
      if (iframes !== undefined && iframes !== null) {
        let frame: any
        for (const iframe of iframes) {
          if ((await iframe.contentFrame()) === elementFrame) {
            frame = iframe
          }
        }
        if (frame !== undefined && frame != null) {
          const frameBox = await frame.boundingBox()
          if (frameBox !== null) {
            elementBox.x -= frameBox.x
            elementBox.y -= frameBox.y
          }
        }
      }
    }

    return elementBox
  } catch {
    try {
      log('Quads not found, trying regular boundingBox')
      const elementBox = await element.boundingBox()
      if (elementBox === null) throw new Error('Element boundingBox is null, falling back to getBoundingClientRect')
      return elementBox
    } catch {
      log('BoundingBox null, using getBoundingClientRect')
      return (element as any).evaluate((el: Element) => {
        const { x, y, width, height } = el.getBoundingClientRect()
        return { x, y, width, height }
      })
    }
  }
}

/** Generates a set of points for mouse movement between two coordinates. */
export function path (
  start: Vector,
  end: Vector | BoundingBox,
  /**
   * Additional options for generating the path.
   * Can also be a number which will set `spreadOverride`.
   */
  // TODO: remove number arg in next major version change, fine to just allow `spreadOverride` in object.
  options?: number | PathOptions): Vector[] | TimedVector[] {
  const optionsResolved: PathOptions = typeof options === 'number'
    ? { spreadOverride: options }
    : { ...options }

  if (start.x === end.x && start.y === end.y) {
    return clampPositive([start], optionsResolved)
  }

  if (optionsResolved.algorithm === 'humancursor') {
    return humanCursorPath(start, end, optionsResolved)
  }

  const DEFAULT_WIDTH = 100
  const MIN_STEPS = 25
  const width = 'width' in end && end.width !== 0 ? end.width : DEFAULT_WIDTH
  const curve = bezierCurve(start, end, optionsResolved.spreadOverride)
  const length = curve.length() * 0.8

  const speed = optionsResolved.moveSpeed !== undefined && optionsResolved.moveSpeed > 0
    ? (25 / optionsResolved.moveSpeed)
    : secureMathRandom()
  const baseTime = speed * MIN_STEPS
  const steps = Math.min(MAX_PATH_STEPS, Math.ceil((Math.log2(fitts(length, width) + 1) + baseTime) * 3))
  const re = curve.getLUT(steps)
  return clampPositive(re, optionsResolved)
}

/** Path generated with the humancursor algorithm (randomized multi-knot curve). */
const humanCursorPath = (start: Vector, end: Vector | BoundingBox, options: PathOptions): Vector[] | TimedVector[] => {
  const endPoint: Vector = { x: end.x, y: end.y }
  const params = generateRandomCurveParameters(start, endPoint)
  const curve = new HumanizeMouseTrajectory(start, endPoint, {
    offsetBoundaryX: options.spreadOverride ?? params.offsetBoundaryX,
    offsetBoundaryY: options.spreadOverride ?? params.offsetBoundaryY,
    knotsCount: params.knotsCount,
    distortionMean: params.distortionMean,
    distortionStDev: params.distortionStDev,
    distortionFrequency: params.distortionFrequency,
    tweening: params.tween,
    targetPoints: params.targetPoints
  })
  return clampPositive(curve.points, options)
}

const clampPositive = (vectors: Vector[], options?: PathOptions): Vector[] | TimedVector[] => {
  const clampedVectors = vectors.map((vector) => ({
    x: Math.max(0, vector.x),
    y: Math.max(0, vector.y)
  }))

  return options?.useTimestamps === true ? generateTimestamps(clampedVectors, options) : clampedVectors
}

const generateTimestamps = (vectors: Vector[], options?: PathOptions): TimedVector[] => {
  const speed = Math.max(0.001, options?.moveSpeed ?? (secureMathRandom() * 0.5 + 0.5))

  const timedVectors: TimedVector[] = []

  for (let i = 0; i < vectors.length; i++) {
    if (i === 0) {
      timedVectors.push({ ...vectors[i], timestamp: Date.now() })
    } else {
      // Time is proportional to the distance between consecutive points (O(n) instead of
      // integrating the curve speed for every segment, which was O(n^2) and could freeze).
      const time = Math.round(magnitude(direction(vectors[i - 1], vectors[i])) / speed)

      timedVectors.push({
        ...vectors[i],
        timestamp: timedVectors[i - 1].timestamp + time
      })
    }
  }

  return timedVectors
}

const shouldOvershoot = (a: Vector, b: Vector, threshold: number): boolean =>
  magnitude(direction(a, b)) > threshold

const intersectsElement = (vec: Vector, box: BoundingBox): boolean => {
  return (
    vec.x > box.x &&
    vec.x <= box.x + box.width &&
    vec.y > box.y &&
    vec.y <= box.y + box.height
  )
}

export class GhostCursor {
  public readonly page: Page
  /** Default options for cursor functions. */
  public defaultOptions: DefaultOptions

  /** Location of the cursor. */
  private location: Vector
  /** Whether mouse is moving via `click`, `move`, `moveTo`, etc. (does not include random movements). Initial state: not moving. */
  private moving: boolean = false
  /** Make the cursor no longer visible. Defined only if `visible=true` was passed, or `installMouseHelper` ran later. */
  private removeMouseHelperFn: undefined | (() => Promise<void>)

  private static readonly OVERSHOOT_SPREAD = 10
  private static readonly OVERSHOOT_RADIUS = 120

  constructor (
    page: Page,
    {
      start = origin,
      performRandomMoves = false,
      defaultOptions = {},
      visible = false
    }:
    {
      /**
         * Cursor start position.
         * @default { x: 0, y: 0 }
         */
      start?: Vector
      /**
         * Initially perform random movements.
         * If `move`,`click`, etc. is performed, these random movements end.
         * @default false
         */
      performRandomMoves?: boolean
      /**
         * Set custom default options for cursor action functions.
         * Default values are described in the type JSdocs.
         */
      defaultOptions?: DefaultOptions
      /**
         * Whether cursor should be made visible using `installMouseHelper`.
         * @default false
         */
      visible?: boolean
    } = {}
  ) {
    this.page = page
    this.location = start
    this.defaultOptions = defaultOptions

    // Playwright tracks the mouse position itself; start it where the cursor starts.
    if (isPlaywrightPage(page) && (start.x !== 0 || start.y !== 0)) {
      getMouseDriver(page).move(start.x, start.y).then(
        (_) => { },
        (_) => { }
      )
    }

    if (visible) {
      // Install mouse helper (visible mouse). Do not await the promise but return immediately
      this.installMouseHelper().then(
        (_) => { },
        (_) => { }
      )
    }

    // Start random mouse movements. Do not await the promise but return immediately
    if (performRandomMoves) {
      this.randomMove().then(
        (_) => { },
        (_) => { }
      )
    }
  }

  /**
   * Install mouse helper (visible cursor).
   */
  public async installMouseHelper (): Promise<void> {
    await installMouseHelper(this.page).then(
      ({ removeMouseHelper }) => {
        this.removeMouseHelperFn = removeMouseHelper
      })
  }

  /**
   * Make the cursor no longer visible.
   * Only has an effect if `visible=true` was passed, or this.installMouseHelper performed manually.
   */
  public async removeMouseHelper (): Promise<void> {
    await this.removeMouseHelperFn?.()
    this.removeMouseHelperFn = undefined
  }

  private async getPageState (): Promise<{
    viewportWidth: number
    viewportHeight: number
    docHeight: number
    docWidth: number
    scrollPositionTop: number
    scrollPositionLeft: number
  }> {
    return (this.page as any).evaluate(() => {
      // Robust against pages without <body> or with body height not matching the document.
      /* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing */
      const body = document.body as HTMLElement | null
      const html = document.documentElement
      return {
        viewportWidth: body?.clientWidth || html.clientWidth || window.innerWidth || 0,
        viewportHeight: body?.clientHeight || html.clientHeight || window.innerHeight || 0,
        docHeight: Math.max(body?.scrollHeight || 0, html.scrollHeight || 0),
        docWidth: Math.max(body?.scrollWidth || 0, html.scrollWidth || 0),
        scrollPositionTop: window.scrollY,
        scrollPositionLeft: window.scrollX
      }
      /* eslint-enable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing */
    })
  }

  /** Move the mouse to a point, getting the vectors via `path(previous, newLocation, options)`  */
  private async moveMouse (
    newLocation: BoundingBox | Vector,
    options?: PathOptions,
    abortOnMove: boolean = false
  ): Promise<void> {
    const mouse = getMouseDriver(this.page)
    const vectors = path(this.location, newLocation, options)

    for (const v of vectors) {
      try {
        // In case this is called from random mouse movements and the users wants to move the mouse, abort
        if (abortOnMove && this.moving) {
          return
        }

        if (!isFiniteVector(v)) {
          log('Warning: non-finite coordinates, skipping point', v)
          continue
        }

        await mouse.move(v.x, v.y, 'timestamp' in v ? v.timestamp : undefined)

        this.location = v
      } catch (error) {
        // Exit function if the browser is no longer connected
        if (!isPageConnected(this.page)) return

        log('Warning: could not move mouse, error message:', error)
      }
    }
  }

  /** Start random mouse movements. Function recursively calls itself. */
  private async randomMove (options?: RandomMoveOptions): Promise<void> {
    const optionsResolved = {
      moveDelay: 2000,
      randomizeMoveDelay: true,
      ...this.defaultOptions?.randomMove,
      ...options
    } satisfies RandomMoveOptions

    try {
      if (!this.moving) {
        const rand = await getRandomPagePoint(this.page)
        await this.moveMouse(rand, optionsResolved, true)
      }
      await delay(optionsResolved.moveDelay * (optionsResolved.randomizeMoveDelay ? secureMathRandom() : 1))
      this.randomMove(options).then(
        (_) => { },
        (_) => { }
      ) // fire and forget, recursive function
    } catch (_) {
      log('Warning: stopping random mouse movements')
    }
  }

  private async mouseButtonAction (
    action: 'down' | 'up',
    options?: MouseButtonOptions
  ): Promise<void> {
    const optionsResolved = {
      button: 'left',
      clickCount: 1,
      ...this.defaultOptions?.click,
      ...options
    } satisfies MouseButtonOptions

    await getMouseDriver(this.page).button(
      action,
      this.location.x,
      this.location.y,
      optionsResolved.button,
      optionsResolved.clickCount
    )
  }

  /** Mouse button down */
  public async mouseDown (options?: MouseButtonOptions): Promise<void> {
    await this.mouseButtonAction('down', options)
  }

  /** Mouse button up (release) */
  public async mouseUp (options?: MouseButtonOptions): Promise<void> {
    await this.mouseButtonAction('up', options)
  }

  /** Toggles random mouse movements on or off. */
  public toggleRandomMove (random: boolean): void {
    this.moving = !random
  }

  /** Get current location of the cursor. */
  public getLocation (): Vector {
    return this.location
  }

  /**
   * Simulates a mouse click at the specified selector or element.
   * Default is to click at current location, don't move.
   */
  public async click (
    selector?: string | ElementHandle | Locator,
    /** @default defaultOptions.click */
    options?: ClickOptions
  ): Promise<void> {
    const optionsResolved = {
      moveDelay: 2000,
      hesitate: 0,
      waitForClick: 0,
      randomizeMoveDelay: true,
      button: 'left',
      clickCount: 1,
      ...this.defaultOptions?.click,
      ...options
    } satisfies ClickOptions

    const wasRandom = !this.moving
    this.toggleRandomMove(false)

    if (selector !== undefined) {
      await this.move(selector, {
        ...optionsResolved,
        // apply moveDelay after click, but not after actual move
        moveDelay: 0
      })
    }

    try {
      await delay(optionsResolved.hesitate)

      await this.mouseDown()
      await delay(resolveDelay(optionsResolved.waitForClick))
      await this.mouseUp()
    } catch (error) {
      log('Warning: could not click mouse, error message:', error)
    }

    await delay(optionsResolved.moveDelay * (optionsResolved.randomizeMoveDelay ? secureMathRandom() : 1))

    this.toggleRandomMove(wasRandom)
  }

  /** Moves the mouse to the specified selector or element. */
  public async move (
    selector: string | ElementHandle | Locator,
    /** @default defaultOptions.move */
    options?: MoveOptions
  ): Promise<void> {
    const optionsResolved = {
      moveDelay: 0,
      maxTries: 10,
      overshootThreshold: 500,
      randomizeMoveDelay: true,
      ...this.defaultOptions?.move,
      ...options
    } satisfies MoveOptions

    const wasRandom = !this.moving
    this.toggleRandomMove(false)

    const go = async (iteration: number): Promise<void> => {
      if (iteration > (optionsResolved.maxTries)) {
        throw Error('Could not mouse-over element within enough tries')
      }

      const elem = await this.getElement(selector, optionsResolved)

      // Make sure the object is in view
      await this.scrollIntoView(elem, optionsResolved)

      const box = await getElementBox(this.page, elem)
      const isHumanCursor = optionsResolved.algorithm === 'humancursor'
      const skipIfClose = optionsResolved.skipMoveIfClose ?? isHumanCursor
      const alreadyInElement = skipIfClose && optionsResolved.destination === undefined &&
        intersectsElement(this.location, box)
      const destination = (optionsResolved.destination !== undefined)
        ? add(box, optionsResolved.destination)
        : alreadyInElement ? this.location : getRandomBoxPoint(box, optionsResolved)
      if (skipIfClose && magnitude(direction(this.location, destination)) <= 5) {
        // Already there (or close enough); don't move.
      } else if (!isHumanCursor && shouldOvershoot(
        this.location,
        destination,
        optionsResolved.overshootThreshold
      )) {
        // overshoot
        await this.moveMouse(overshoot(destination, GhostCursor.OVERSHOOT_RADIUS), optionsResolved)

        // then go to the box
        await this.moveMouse({ ...box, ...destination }, {
          ...optionsResolved,
          spreadOverride: GhostCursor.OVERSHOOT_SPREAD
        })
      } else {
        // go directly to the box, no overshoot
        await this.moveMouse(destination, optionsResolved)
      }

      const newBoundingBox = await getElementBox(this.page, elem)

      // It's possible that the element that is being moved towards
      // has moved to a different location by the time
      // the the time the mouseover animation finishes
      if (!intersectsElement(this.location, newBoundingBox)) {
        return await go(iteration + 1)
      }
    }
    await go(0)

    this.toggleRandomMove(wasRandom)

    await delay(optionsResolved.moveDelay * (optionsResolved.randomizeMoveDelay ? secureMathRandom() : 1))
  }

  /** Moves the mouse to the specified destination point. */
  public async moveTo (
    destination: Vector,
    /** @default defaultOptions.moveTo */
    options?: MoveToOptions
  ): Promise<void> {
    const optionsResolved = {
      moveDelay: 0,
      randomizeMoveDelay: true,
      ...this.defaultOptions?.moveTo,
      ...options
    } satisfies MoveToOptions

    const wasRandom = !this.moving
    this.toggleRandomMove(false)
    const skipIfClose = optionsResolved.skipMoveIfClose ?? optionsResolved.algorithm === 'humancursor'
    if (!skipIfClose || magnitude(direction(this.location, destination)) > 5) {
      await this.moveMouse(destination, optionsResolved)
    }
    this.toggleRandomMove(wasRandom)

    await delay(optionsResolved.moveDelay * (optionsResolved.randomizeMoveDelay ? secureMathRandom() : 1))
  }

  /** Moves the mouse by a specified amount */
  public async moveBy (delta: Partial<Vector>, options?: MoveToOptions): Promise<void> {
    await this.moveTo(add(this.location, { x: 0, y: 0, ...delta }), options)
  }

  /** Scrolls the element into view. If already in view, no scroll occurs. */
  public async scrollIntoView (
    selector: string | ElementHandle | Locator,
    /** @default defaultOptions.scroll */
    options?: ScrollIntoViewOptions
  ): Promise<void> {
    const optionsResolved = {
      scrollDelay: 200,
      scrollSpeed: 100,
      inViewportMargin: 0,
      ...this.defaultOptions?.scroll,
      ...options
    } satisfies ScrollIntoViewOptions

    const scrollSpeed = clamp(optionsResolved.scrollSpeed, 1, 100)

    const elem = await this.getElement(selector, optionsResolved)

    const {
      viewportWidth,
      viewportHeight,
      docHeight,
      docWidth,
      scrollPositionTop,
      scrollPositionLeft
    } = await this.getPageState()

    const elemBoundingBox = await getElementBox(this.page, elem) // is relative to viewport
    const elemBox = {
      top: elemBoundingBox.y,
      left: elemBoundingBox.x,
      bottom: elemBoundingBox.y + elemBoundingBox.height,
      right: elemBoundingBox.x + elemBoundingBox.width
    }

    // Add margin around the element
    const marginedBox = {
      top: elemBox.top - optionsResolved.inViewportMargin,
      left: elemBox.left - optionsResolved.inViewportMargin,
      bottom: elemBox.bottom + optionsResolved.inViewportMargin,
      right: elemBox.right + optionsResolved.inViewportMargin
    }

    // Get position relative to the whole document
    const marginedBoxRelativeToDoc = {
      top: marginedBox.top + scrollPositionTop,
      left: marginedBox.left + scrollPositionLeft,
      bottom: marginedBox.bottom + scrollPositionTop,
      right: marginedBox.right + scrollPositionLeft
    }

    // Convert back to being relative to the viewport-- though if box with margin added goes outside
    // the document, restrict to being *within* the document.
    // This makes it so that when element is on the edge of window scroll, isInViewport=true even after
    // margin was added.
    const targetBox = {
      top: Math.max(marginedBoxRelativeToDoc.top, 0) - scrollPositionTop,
      left: Math.max(marginedBoxRelativeToDoc.left, 0) - scrollPositionLeft,
      bottom: Math.min(marginedBoxRelativeToDoc.bottom, docHeight) - scrollPositionTop,
      right: Math.min(marginedBoxRelativeToDoc.right, docWidth) - scrollPositionLeft
    }

    const { top, left, bottom, right } = targetBox

    const isInViewport = top >= 0 &&
      left >= 0 &&
      bottom <= viewportHeight &&
      right <= viewportWidth

    if (isInViewport) return

    const manuallyScroll = async (): Promise<void> => {
      let deltaY: number = 0
      let deltaX: number = 0

      if (top < 0) {
        deltaY = top // Scroll up
      } else if (bottom > viewportHeight) {
        deltaY = bottom - viewportHeight // Scroll down
      }

      if (left < 0) {
        deltaX = left // Scroll left
      } else if (right > viewportWidth) {
        deltaX = right - viewportWidth// Scroll right
      }

      if (optionsResolved.randomScrollPadding === true) {
        // Humans don't scroll perfectly: over/under-scroll by up to 10% of the distance (max 50px).
        const jitter = (distance: number): number =>
          (secureMathRandom() * 2 - 1) * Math.min(Math.abs(distance) * 0.1, 50)
        deltaX += jitter(deltaX)
        deltaY += jitter(deltaY)
      }

      await this.scroll({ x: deltaX, y: deltaY }, optionsResolved)
    }

    try {
      const useInstantScroll = scrollSpeed === 100 &&
        optionsResolved.inViewportMargin <= 0 &&
        optionsResolved.randomScrollPadding !== true &&
        optionsResolved.scrollMode !== 'momentum'
      if (useInstantScroll && (await elem.boundingBox()) !== null) {
        try {
          await scrollIntoViewIfNeeded(this.page, elem)
        } catch {
          await manuallyScroll()
        }
      } else {
        await manuallyScroll()
      }
    } catch (e: any) {
      // use regular JS scroll method as a fallback
      if (typeof e?.message === 'string' && (e.message as string).includes('Node does not have a layout object')) {
        log('Node does not have a layout object, falling back to JS scroll method')
      } else {
        log('Falling back to JS scroll method', e)
      }
      await (elem as any).evaluate((e: Element, smooth: boolean) => e.scrollIntoView({
        block: 'center',
        behavior: smooth ? 'smooth' : undefined
      }), scrollSpeed < 90)
    }
  }

  /** Scrolls the page the distance set by `delta`. */
  public async scroll (
    delta: Partial<Vector>,
    /** @default defaultOptions.scroll */
    options?: ScrollOptions
  ): Promise<void> {
    const optionsResolved = {
      scrollDelay: 200,
      scrollSpeed: 100,
      ...this.defaultOptions?.scroll,
      ...options
    } satisfies ScrollOptions

    const scrollSpeed = clamp(optionsResolved.scrollSpeed, 1, 100)

    const mouse = getMouseDriver(this.page)

    if (optionsResolved.scrollMode === 'momentum') {
      // scrollSpeed 100 = 300ms, scrollSpeed 1 = 2000ms
      const duration = scale(scrollSpeed, [1, 100], [2000, 300])
      await this.momentumScroll(delta.x ?? 0, delta.y ?? 0, duration)
      await delay(optionsResolved.scrollDelay)
      return
    }

    let deltaX = delta.x ?? 0
    let deltaY = delta.y ?? 0
    const xDirection = deltaX < 0 ? -1 : 1
    const yDirection = deltaY < 0 ? -1 : 1

    deltaX = Math.abs(deltaX)
    deltaY = Math.abs(deltaY)

    const largerDistanceDir = deltaX > deltaY ? 'x' : 'y'
    const [largerDistance, shorterDistance] = largerDistanceDir === 'x' ? [deltaX, deltaY] : [deltaY, deltaX]

    // When scrollSpeed under 90, pixels moved each scroll is equal to the scrollSpeed. 1 is as slow as we can get (without adding a delay), and 90 is pretty fast.
    // Above 90 though, scale all the way to the full distance so that scrollSpeed=100 results in only 1 scroll action.
    const EXP_SCALE_START = 90
    const largerDistanceScrollStep = scrollSpeed < EXP_SCALE_START
      ? scrollSpeed
      : scale(scrollSpeed, [EXP_SCALE_START, 100], [EXP_SCALE_START, largerDistance])

    const numSteps = largerDistanceScrollStep > 0
      ? Math.min(MAX_SCROLL_STEPS, Math.floor(largerDistance / largerDistanceScrollStep))
      : 0
    const largerDistanceRemainder = largerDistanceScrollStep > 0 ? largerDistance % largerDistanceScrollStep : 0
    const shorterDistanceScrollStep = numSteps > 0 ? Math.floor(shorterDistance / numSteps) : 0
    const shorterDistanceRemainder = numSteps > 0 ? shorterDistance % numSteps : 0

    for (let i = 0; i < numSteps; i++) {
      let longerDistanceDelta = largerDistanceScrollStep
      let shorterDistanceDelta = shorterDistanceScrollStep
      if (i === numSteps - 1) {
        longerDistanceDelta += largerDistanceRemainder
        shorterDistanceDelta += shorterDistanceRemainder
      }
      let [deltaX, deltaY] = largerDistanceDir === 'x'
        ? [longerDistanceDelta, shorterDistanceDelta]
        : [shorterDistanceDelta, longerDistanceDelta]
      deltaX = deltaX * xDirection
      deltaY = deltaY * yDirection

      if (Number.isFinite(deltaX) && Number.isFinite(deltaY)) {
        await mouse.wheel(this.location.x, this.location.y, deltaX, deltaY)
      }
    }

    await delay(optionsResolved.scrollDelay)
  }

  /**
   * Scrolls by (`x`, `y`) with a stream of wheel events following an ease-out-cubic curve
   * (fast start, slow finish) over `duration` ms. Ticks are ~16ms apart with ±2ms jitter.
   */
  private async momentumScroll (x: number, y: number, duration: number): Promise<void> {
    const mouse = getMouseDriver(this.page)
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
    const startTime = Date.now()
    let scrolledX = 0
    let scrolledY = 0
    let nextTick = startTime
    for (;;) {
      const t = Math.min((Date.now() - startTime) / duration, 1)
      // Send the remaining delta up to this point, so rounding never accumulates and totals are exact.
      const dx = Math.round(x * ease(t)) - scrolledX
      const dy = Math.round(y * ease(t)) - scrolledY
      if (dx !== 0 || dy !== 0) {
        await mouse.wheel(this.location.x, this.location.y, dx, dy)
        scrolledX += dx
        scrolledY += dy
      }
      if (t >= 1) return
      nextTick += 16 + (secureMathRandom() * 4 - 2)
      await delay(nextTick - Date.now())
    }
  }

  /** Scrolls to the specified destination point. */
  public async scrollTo (
    destination: ScrollToDestination,
    /** @default defaultOptions.scroll */
    options?: ScrollOptions
  ): Promise<void> {
    const optionsResolved = {
      scrollDelay: 200,
      scrollSpeed: 100,
      ...this.defaultOptions?.scroll,
      ...options
    } satisfies ScrollOptions

    const {
      docHeight,
      docWidth,
      scrollPositionTop,
      scrollPositionLeft
    } = await this.getPageState()

    const to: Partial<Vector> = await (async (): Promise<Partial<Vector>> => {
      switch (destination) {
        case 'top':
          return { y: 0 }
        case 'bottom':
          return { y: docHeight }
        case 'left':
          return { x: 0 }
        case 'right':
          return { x: docWidth }
        default: {
          if (isElementHandle(destination) || isPlaywrightLocator(destination)) {
            const box = await (destination as any).boundingBox() as BoundingBox | null
            if (box == null) {
              throw new Error('no boundingBox')
            }
            // boundingBox() is viewport-relative; convert to document-relative
            return {
              x: box.x + scrollPositionLeft,
              y: box.y + scrollPositionTop
            }
          }

          // Partial<Vector>
          return destination
        }
      }
    })()

    await this.scroll({
      y: to.y !== undefined ? to.y - scrollPositionTop : 0,
      x: to.x !== undefined ? to.x - scrollPositionLeft : 0
    }, optionsResolved)
  }

  /** Gets the element via a selector. Can use an XPath. */
  public async getElement (
    selector: string | ElementHandle | Locator,
    /** @default defaultOptions.getElement */
    options?: GetElementOptions
  ): Promise<ElementHandle> {
    const optionsResolved = {
      ...this.defaultOptions?.getElement,
      ...options
    } satisfies GetElementOptions

    let elem: ElementHandle | null = null
    if (typeof selector === 'string') {
      elem = await querySelector(this.page, selector, optionsResolved.waitForSelector)
      if (elem === null) {
        throw new Error(
          `Could not find element with selector "${selector}", make sure you're waiting for the elements by specifying "waitForSelector"`
        )
      }
    } else if (isPlaywrightLocator(selector)) {
      elem = await selector.first().elementHandle(
        optionsResolved.waitForSelector !== undefined ? { timeout: optionsResolved.waitForSelector } : undefined
      )
      if (elem === null) throw new Error('Could not resolve Locator to an element')
    } else {
      // ElementHandle
      elem = selector
    }
    return elem
  }
}

/**
 * @deprecated
 * TODO: Remove on next major version change. Prefer to just do `new GhostCursor` instead of this function.
 * Is here because removing would be breaking.
 */
export const createCursor = (
  page: Page,
  /**
   * Cursor start position.
   * @default { x: 0, y: 0 }
   */
  start: Vector = origin,
  /**
   * Initially perform random movements.
   * If `move`,`click`, etc. is performed, these random movements end.
   * @default false
   */
  performRandomMoves: boolean = false,
  /**
   * Default options for cursor functions.
   */
  defaultOptions: DefaultOptions = {},
  /**
   * Whether cursor should be made visible using `installMouseHelper`.
   * @default false
   */
  visible: boolean = false
): GhostCursor => new GhostCursor(page, { start, performRandomMoves, defaultOptions, visible })
