import { describe, expect, it } from 'vitest'
import {
  highlightHtml,
  tokenClass,
  tokenColor,
  tokenCssRules,
  tokenizeCode,
  type TokenKind,
} from './highlight'

/** `[text, kind]` pairs, so an expectation reads like the snippet it describes. */
const kinds = (text: string): Array<[string, TokenKind]> =>
  tokenizeCode(text).map((token) => [token.text, token.kind])

describe('tokenizeCode', () => {
  it('reproduces the input exactly — the invariant every escaper leans on', () => {
    const corpus = [
      '',
      'plain prose',
      'if (a) {\n  b = 2;\n}',
      '#!/usr/bin/env bash\necho "hi $NAME" # greeting\n',
      '/* block\n   comment */ x = 0xFFu;',
      'def f(x):\n    """doc\n    string"""\n    return x + 1.5e-3\n',
      "const s = `a\nb` + 'it\\'s' + \"#not a comment\";",
      '#include <stdio.h>\nint main(void) { return 0; }',
      'SELECT * FROM t WHERE id = 42;',
      'obj.map(x).then(y) // member calls are not keywords',
      'box = [1, 2]; // TODO: 3.14 counts as one number',
      '😀 = "🚀"',
      's = "unterminated\nnext = 1',
      '/**/',
      '#',
      '///',
    ]
    for (const text of corpus) {
      expect(
        tokenizeCode(text)
          .map((token) => token.text)
          .join(''),
      ).toBe(text)
    }
  })

  it('returns nothing for an empty snippet', () => {
    expect(tokenizeCode('')).toEqual([])
  })

  it('classifies comments in every spelling, and only comments', () => {
    expect(kinds('// note')).toEqual([['// note', 'comment']])
    expect(kinds('/* a\nb */')).toEqual([['/* a\nb */', 'comment']])
    expect(kinds('# note')).toEqual([['# note', 'comment']])
    expect(kinds('#noSpace')).toEqual([['#noSpace', 'comment']])
    expect(kinds('#!/bin/sh')).toEqual([['#!/bin/sh', 'comment']])
    expect(kinds('x = 1 // tally')).toEqual([
      ['x = ', 'plain'],
      ['1', 'number'],
      [' ', 'plain'],
      ['// tally', 'comment'],
    ])
    // An unterminated block comment ends with the snippet, not past it.
    expect(kinds('/* open')).toEqual([['/* open', 'comment']])
  })

  it('keeps a preprocessor directive out of the comment pile', () => {
    expect(kinds('#include <stdio.h>')).toEqual([
      ['#include', 'keyword'],
      [' <stdio.h>', 'plain'],
    ])
    expect(kinds('#define N 4')).toEqual([
      ['#define', 'keyword'],
      [' N ', 'plain'],
      ['4', 'number'],
    ])
  })

  it('classifies strings in all four quoting styles', () => {
    expect(kinds('a = "x"')).toEqual([
      ['a = ', 'plain'],
      ['"x"', 'string'],
    ])
    expect(kinds("b = 'y'")).toEqual([
      ['b = ', 'plain'],
      ["'y'", 'string'],
    ])
    expect(kinds('c = `t`')).toEqual([
      ['c = ', 'plain'],
      ['`t`', 'string'],
    ])
    expect(kinds('d = """doc"""')).toEqual([
      ['d = ', 'plain'],
      ['"""doc"""', 'string'],
    ])
    // A backslash escapes the next character, quote included…
    expect(kinds('s = "a\\"b"')).toEqual([
      ['s = ', 'plain'],
      ['"a\\"b"', 'string'],
    ])
    // …an unterminated quote stops at the newline instead of swallowing the
    // rest of the snippet, and a template literal may cross lines.
    expect(kinds('s = "open\nnext = 1')).toEqual([
      ['s = ', 'plain'],
      ['"open', 'string'],
      ['\nnext = ', 'plain'],
      ['1', 'number'],
    ])
    expect(kinds('`a\nb`')).toEqual([['`a\nb`', 'string']])
  })

  it('classifies numbers, however the language spells them', () => {
    expect(kinds('42 3.14 0xFF 1_000u')).toEqual([
      ['42', 'number'],
      [' ', 'plain'],
      ['3.14', 'number'],
      [' ', 'plain'],
      ['0xFF', 'number'],
      [' ', 'plain'],
      ['1_000u', 'number'],
    ])
    // A leading zero does not turn `0;` into an unfinished literal.
    expect(kinds('for (i = 0; i < n; i++)')).toEqual([
      ['for', 'keyword'],
      [' (i = ', 'plain'],
      ['0', 'number'],
      ['; i < n; i++)', 'plain'],
    ])
  })

  it('paints a keyword, and never one hiding behind a dot', () => {
    expect(kinds('if (a)')).toEqual([
      ['if', 'keyword'],
      [' (a)', 'plain'],
    ])
    expect(kinds('const x = null')).toEqual([
      ['const', 'keyword'],
      [' x = ', 'plain'],
      ['null', 'keyword'],
    ])
    // `map` sits behind a dot, so it is a property — the rule that lets the
    // set keep `get`, `set`, `map` and `type` without painting every call.
    expect(kinds('obj.map(x)')).toEqual([
      ['obj.', 'plain'],
      ['map', 'function'],
      ['(x)', 'plain'],
    ])
    expect(kinds('p.then(q)')).toEqual([
      ['p.', 'plain'],
      ['then', 'function'],
      ['(q)', 'plain'],
    ])
    // A keyword opening a call stays a keyword, not a function.
    expect(kinds('if (x) {')).toEqual([
      ['if', 'keyword'],
      [' (x) {', 'plain'],
    ])
  })

  it('treats a bare word that opens a call as a function', () => {
    expect(kinds('greet(name)')).toEqual([
      ['greet', 'function'],
      ['(name)', 'plain'],
    ])
    expect(kinds('x = main()')).toEqual([
      ['x = ', 'plain'],
      ['main', 'function'],
      ['()', 'plain'],
    ])
  })

  it('merges adjacent tokens of one kind', () => {
    expect(tokenizeCode('a + b')).toEqual([{ text: 'a + b', kind: 'plain' }])
    expect(tokenizeCode('// one\n// two')).toEqual([
      { text: '// one', kind: 'comment' },
      { text: '\n', kind: 'plain' },
      { text: '// two', kind: 'comment' },
    ])
  })

  it('never loses a character of an identifier outside Latin script', () => {
    const text = 'ဖန်(၁) = 42'
    expect(
      tokenizeCode(text)
        .map((token) => token.text)
        .join(''),
    ).toBe(text)
  })
})

describe('highlightHtml', () => {
  it('wraps coloured tokens in spans and leaves plain text bare', () => {
    expect(highlightHtml('if (a) {')).toBe('<span class="tok-k">if</span> (a) {')
  })

  it('escapes what the snippet says inside every token', () => {
    expect(highlightHtml('<b> & "s"')).toBe(
      '&lt;b&gt; &amp; <span class="tok-s">&quot;s&quot;</span>',
    )
  })

  it('leaves a snippet with no recognisable token as the plain escaped text', () => {
    expect(highlightHtml('plain words')).toBe('plain words')
  })

  it('keeps the newlines a pre wrapping depends on', () => {
    expect(highlightHtml('a\nb')).toBe('a\nb')
  })
})

describe('the palette', () => {
  it('gives every coloured kind a class and a run colour, and plain neither', () => {
    expect(tokenClass('comment')).toBe('tok-c')
    expect(tokenClass('string')).toBe('tok-s')
    expect(tokenClass('number')).toBe('tok-n')
    expect(tokenClass('keyword')).toBe('tok-k')
    expect(tokenClass('function')).toBe('tok-f')
    expect(tokenClass('plain')).toBeNull()
    expect(tokenColor('comment')).toBe('008000')
    expect(tokenColor('string')).toBe('A31515')
    expect(tokenColor('number')).toBe('098658')
    expect(tokenColor('keyword')).toBe('0000FF')
    expect(tokenColor('function')).toBe('795E26')
    expect(tokenColor('plain')).toBeNull()
  })

  it('writes one stylesheet rule per coloured kind, in the DOCX colours', () => {
    const css = tokenCssRules()
    for (const kind of ['comment', 'string', 'number', 'keyword', 'function'] as const) {
      expect(css).toContain(`.${tokenClass(kind)} { color: #${tokenColor(kind)}; }`)
    }
    expect(css).not.toContain('.plain')
  })
})
