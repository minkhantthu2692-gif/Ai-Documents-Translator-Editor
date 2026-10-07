import { describe, expect, it } from 'vitest'
import { htmlToText, isSanitized, sanitizeDocument, sanitizeHtml } from './sanitize'

describe('sanitizeHtml', () => {
  it('keeps the markup the editor produces', () => {
    const html = '<p class="block" style="font-size:12pt"><strong>Bold</strong> text</p>'
    expect(sanitizeHtml(html)).toBe(html)
  })

  it('removes script tags and their content', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>')
    expect(out).toContain('<p>ok</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
  })

  it('strips inline event handlers', () => {
    const out = sanitizeHtml('<img src="x.png" onerror="steal()">')
    expect(out).not.toContain('onerror')
    expect(out).toContain('src="x.png"')
  })

  it('blocks javascript: URLs', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('click')
  })

  it('drops iframes, forms and embeds', () => {
    expect(sanitizeHtml('<iframe src="https://evil"></iframe>')).not.toContain('iframe')
    expect(sanitizeHtml('<form action="/x"><input name="a"></form>')).not.toContain('input')
    expect(sanitizeHtml('<embed src="x">')).not.toContain('embed')
  })

  it('is idempotent', () => {
    const html = '<div dir="rtl"><span style="color:#000">سلام</span></div>'
    expect(sanitizeHtml(sanitizeHtml(html))).toBe(sanitizeHtml(html))
    expect(isSanitized(html)).toBe(true)
  })

  it('returns an empty string for empty input', () => {
    expect(sanitizeHtml('')).toBe('')
  })
})

describe('sanitizeDocument', () => {
  it('keeps the html/head/body skeleton the print frame needs', () => {
    const out = sanitizeDocument(
      '<!doctype html><html><head><style>@page{size:612pt 792pt}</style></head><body><p>hi</p></body></html>',
    )
    expect(out).toContain('<html')
    expect(out).toContain('@page')
    expect(out).toContain('<p>hi</p>')
    expect(out).not.toContain('<script')
  })

  it('still removes scripts from a whole document', () => {
    const out = sanitizeDocument('<html><body><p>x</p><script>bad()</script></body></html>')
    expect(out).not.toContain('bad()')
  })
})

describe('htmlToText', () => {
  it('flattens markup to readable text', () => {
    expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello World')
  })

  it('turns <br> into a space rather than gluing words', () => {
    expect(htmlToText('one<br>two')).toBe('one two')
  })

  it('handles an empty string', () => {
    expect(htmlToText('')).toBe('')
  })
})
