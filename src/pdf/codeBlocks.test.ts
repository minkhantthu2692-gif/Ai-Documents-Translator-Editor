import { describe, expect, it } from 'vitest'
import {
  codeBlockText,
  codeLineSignal,
  isMonospaceFamily,
  looksLikeCodeBlock,
  looksLikeCodeLine,
  type CodeLineLike,
} from './codeBlocks'

function codeLine(text: string, x: number, w: number, fontFamily = 'Courier'): CodeLineLike {
  return { text, bbox: { x, w }, style: { fontFamily } }
}

describe('isMonospaceFamily', () => {
  it('recognises the faces a manual sets its examples in', () => {
    expect(isMonospaceFamily('Courier')).toBe(true)
    expect(isMonospaceFamily('CourierNewPSMT')).toBe(true)
    expect(isMonospaceFamily('ABCDEF+Consolas')).toBe(true)
    expect(isMonospaceFamily('DejaVuSansMono')).toBe(true)
    expect(isMonospaceFamily('LiberationMono')).toBe(true)
    expect(isMonospaceFamily('Menlo')).toBe(true)
    expect(isMonospaceFamily('SourceCodePro-Regular')).toBe(true)
  })

  it('leaves the body face alone', () => {
    expect(isMonospaceFamily('Helvetica')).toBe(false)
    expect(isMonospaceFamily('Times-Roman')).toBe(false)
    expect(isMonospaceFamily('Arial-BoldMT')).toBe(false)
    expect(isMonospaceFamily('')).toBe(false)
  })
})

describe('codeLineSignal', () => {
  it('takes a statement, a call and a lone delimiter', () => {
    expect(codeLineSignal('const x = 5;')).toBe(true)
    expect(codeLineSignal('if (ready) {')).toBe(true)
    expect(codeLineSignal('}')).toBe(true)
    expect(codeLineSignal('});')).toBe(true)
  })

  it('leaves prose alone', () => {
    expect(codeLineSignal('The quick brown fox')).toBe(false)
    expect(codeLineSignal('')).toBe(false)
    expect(codeLineSignal('   ')).toBe(false)
  })
})

describe('looksLikeCodeLine', () => {
  it('needs both the face and the punctuation', () => {
    expect(looksLikeCodeLine(codeLine('const x = 5;', 72, 72))).toBe(true)
    expect(looksLikeCodeLine(codeLine('const x = 5;', 72, 72, 'Helvetica'))).toBe(false)
    expect(looksLikeCodeLine(codeLine('Ordinary prose.', 72, 84))).toBe(false)
  })
})

describe('looksLikeCodeBlock', () => {
  it('takes a monospaced run whose lines read as statements', () => {
    expect(
      looksLikeCodeBlock([
        codeLine('const total = sum(items);', 72, 150),
        codeLine('return total;', 72, 78),
      ]),
    ).toBe(true)
  })

  it('takes a single monospaced statement', () => {
    expect(looksLikeCodeBlock([codeLine('const x = 5;', 72, 72)])).toBe(true)
  })

  it('takes a nested monospaced block that carries no punctuation at all', () => {
    // YAML, JSON and indented plain-text configuration have no braces to
    // score; the nesting is the whole signal.
    expect(
      looksLikeCodeBlock([
        codeLine('server:', 72, 42, 'Menlo'),
        codeLine('port: 8080', 72, 66, 'Menlo'),
        codeLine('host: localhost', 96, 90, 'Menlo'),
      ]),
    ).toBe(true)
  })

  it('leaves a flush-left monospaced address block alone', () => {
    expect(
      looksLikeCodeBlock([codeLine('123 Main Street', 72, 90), codeLine('Springfield IL', 72, 84)]),
    ).toBe(false)
  })

  it('leaves a *centred* monospaced block alone', () => {
    // Centring gives every line its own left edge, which reads exactly like
    // indentation unless something also holds the margin.
    expect(
      looksLikeCodeBlock([
        codeLine('A short line', 200, 72),
        codeLine('another short one', 180, 102),
      ]),
    ).toBe(false)
  })

  it('takes a snippet the PDF set in the body face', () => {
    expect(
      looksLikeCodeBlock([
        codeLine('function greet(name) {', 72, 130, 'Helvetica'),
        codeLine('return name;', 72, 72, 'Helvetica'),
        codeLine('}', 72, 6, 'Helvetica'),
      ]),
    ).toBe(true)
  })

  it('leaves proportional prose alone', () => {
    expect(
      looksLikeCodeBlock([
        codeLine('The quick brown fox jumps', 72, 150, 'Helvetica'),
        codeLine('over the lazy dog again', 72, 138, 'Helvetica'),
      ]),
    ).toBe(false)
  })

  it('takes nothing at all from an empty run', () => {
    expect(looksLikeCodeBlock([])).toBe(false)
    expect(looksLikeCodeBlock([codeLine('   ', 72, 0)])).toBe(false)
  })
})

describe('codeBlockText', () => {
  it('puts the indentation back from the bounding boxes', () => {
    // Every line is six points wide per character, so the eight-column step
    // between the first and the second is exactly two spaces.
    const text = codeBlockText([
      codeLine('if (a) {', 72, 48),
      codeLine('a = 1;', 84, 36),
      codeLine('}', 72, 6),
    ])
    expect(text).toBe('if (a) {\n  a = 1;\n}')
  })

  it('keeps a blank line empty rather than padding it', () => {
    const text = codeBlockText([
      codeLine('aaaa', 72, 24),
      codeLine('', 84, 0),
      codeLine('bbbb', 84, 24),
    ])
    expect(text).toBe('aaaa\n\n  bbbb')
  })

  it('caps the step so a degenerate box cannot emit a page of spaces', () => {
    // 300 points over a six-point advance is fifty columns; only forty land.
    const text = codeBlockText([codeLine('aaaa', 72, 24), codeLine('bbbb', 372, 24)])
    expect(text).toBe(`aaaa\n${' '.repeat(40)}bbbb`)
  })

  it('falls back to the plain join when there is nothing to measure', () => {
    const lines = [codeLine('aaaa', 72, 0), codeLine('bbbb', 84, 0)]
    expect(codeBlockText(lines)).toBe('aaaa\nbbbb')
    expect(codeBlockText([codeLine('aaaa', 72, 24)])).toBe('aaaa')
  })
})
