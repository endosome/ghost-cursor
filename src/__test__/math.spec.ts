import { generateBezierAnchors, isFiniteVector, perpendicular, secureMathRandom, unit } from '../math'
import { path } from '../spoof'

describe('Math utilities', () => {
  it('perpendicular returns a perpendicular vector', () => {
    const cases = [
      [{ x: 1, y: 0 }, { x: 0, y: -1 }],
      [{ x: 0, y: 1 }, { x: 1, y: 0 }],
      [{ x: 1, y: 1 }, { x: 1, y: -1 }],
      [{ x: -5, y: 10 }, { x: 10, y: 5 }],
      [{ x: -3, y: -4 }, { x: -4, y: 3 }]
    ]
    for (const [v, expected] of cases) {
      const p = perpendicular(v)
      expect(p.x * v.x + p.y * v.y).toBe(0)
      expect(p).toEqual(expected)
    }
  })

  it('perpendicular handles the zero vector (no -0)', () => {
    expect(perpendicular({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('unit of the zero vector is the zero vector, not NaN', () => {
    expect(unit({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('secureMathRandom returns numbers in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const n = secureMathRandom()
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(1)
    }
  })

  it('isFiniteVector', () => {
    expect(isFiniteVector({ x: 1, y: 2 })).toBe(true)
    expect(isFiniteVector({ x: NaN, y: 2 })).toBe(false)
    expect(isFiniteVector({ x: 1, y: Infinity })).toBe(false)
  })

  it('bezier anchors are ordered in the direction of travel', () => {
    for (let i = 0; i < 50; i++) {
      const [a1, a2] = generateBezierAnchors({ x: 500, y: 0 }, { x: 0, y: 0 }, 100)
      expect(a1.x).toBeGreaterThanOrEqual(a2.x)
      const [b1, b2] = generateBezierAnchors({ x: 0, y: 0 }, { x: 500, y: 0 }, 100)
      expect(b1.x).toBeLessThanOrEqual(b2.x)
    }
  })
})

describe('path', () => {
  const allFinite = (points: Array<{ x: number, y: number }>): boolean => points.every(isFiniteVector)

  it('returns a single point when start and end are the same (no NaN)', () => {
    expect(path({ x: 10, y: 10 }, { x: 10, y: 10 })).toEqual([{ x: 10, y: 10 }])
    expect(path({ x: 10, y: 10 }, { x: 10, y: 10 }, { algorithm: 'humancursor' })).toEqual([{ x: 10, y: 10 }])
  })

  it.each(['ghost', 'humancursor'] as const)('%s: starts and ends at the given points', (algorithm) => {
    const points = path({ x: 10, y: 20 }, { x: 400, y: 300 }, { algorithm })
    expect(points.length).toBeGreaterThan(2)
    expect(allFinite(points)).toBe(true)
    expect(points[0].x).toBeCloseTo(10)
    expect(points[0].y).toBeCloseTo(20)
    expect(points[points.length - 1].x).toBeCloseTo(400)
    expect(points[points.length - 1].y).toBeCloseTo(300)
  })

  it.each(['ghost', 'humancursor'] as const)('%s: timestamps increase monotonically', (algorithm) => {
    const points = path({ x: 0, y: 0 }, { x: 300, y: 300 }, { algorithm, useTimestamps: true }) as Array<{ timestamp: number }>
    for (let i = 1; i < points.length; i++) {
      expect(points[i].timestamp).toBeGreaterThanOrEqual(points[i - 1].timestamp)
    }
  })

  it('caps the number of steps for extreme inputs', () => {
    const start = Date.now()
    const points = path({ x: 0, y: 0 }, { x: 1e7, y: 1e7 }, { moveSpeed: 1e-9, useTimestamps: true })
    expect(points.length).toBeLessThanOrEqual(10001)
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it.each(['ghost', 'humancursor'] as const)('%s: non-finite targets return only the start point', (algorithm) => {
    for (const end of [{ x: NaN, y: 5 }, { x: Infinity, y: 5 }, { x: 5, y: -Infinity }]) {
      expect(path({ x: 1, y: 2 }, end, { algorithm })).toEqual([{ x: 1, y: 2 }])
    }
  })

  it.each(['ghost', 'humancursor'] as const)('%s: huge distances return promptly', (algorithm) => {
    const start = Date.now()
    const points = path({ x: 0, y: 0 }, { x: 1e12, y: 1e12 }, { algorithm })
    expect(points.length).toBeLessThanOrEqual(10001)
    expect(points.every(isFiniteVector)).toBe(true)
    expect(Date.now() - start).toBeLessThan(5000)
  })
})
