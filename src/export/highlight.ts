/**
 * Syntax colouring for code snippets, re-derived at export time.
 *
 * A PDF says *where* glyphs are and *which font* set them; it never says a
 * run was a keyword or a string literal, and the operator list does not
 * record the colours the original tool painted either — those resolve at
 * paint time, and a snippet printed in a single colour has none to recover.
 * So the colouring is re-derived from the printed text with a small
 * language-agnostic lexer.
 *
 * Generic on purpose: extraction records `kind: 'code'`, never the language,
 * and a fence labelled with the wrong language would render — and misrender —
 * with authority. The rules cover what C-like, Python-like, shell and SQL
 * snippets share: line and block comments, quoted strings in all four quoting
 * styles, numeric literals, preprocessor directives, a curated keyword set,
 * and any word that opens a parenthesis. A word directly after `.` is never a
 * keyword (`obj.map(...)`, `.then(...)`) — it is a property call or plain
 * text — which is what lets `get`, `set`, `map` and `type` stay in the set.
 *
 * Adjacent tokens of one kind are merged, so rendering the list back out
 * token by token reproduces the input exactly — the invariant every format's
 * escaping depends on.
 */
import { escapeHtml } from './shared'

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'function' | 'plain'

export interface CodeToken {
  text: string
  kind: TokenKind
}

/**
 * Words that paint as keywords wherever they appear bare.
 *
 * Curated rather than exhaustive: a word wrongly painted is worse than one
 * left plain, so collision-prone candidates stay out — `then` (Promise),
 * `value`, `key`, `next`, `data`, `name` — and the member-guard rule protects
 * the rest (`obj.delete`, `p.finally`).
 */
const KEYWORDS = new Set<string>([
  // C / C++
  'auto',
  'break',
  'case',
  'char',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'double',
  'else',
  'enum',
  'extern',
  'float',
  'for',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'operator',
  'register',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'struct',
  'switch',
  'typedef',
  'union',
  'unsigned',
  'void',
  'volatile',
  'while',
  'class',
  'namespace',
  'new',
  'template',
  'typename',
  'public',
  'private',
  'protected',
  'virtual',
  'override',
  'final',
  'friend',
  'try',
  'catch',
  'throw',
  'nullptr',
  'true',
  'false',
  'using',
  'constexpr',
  'explicit',
  // JavaScript / TypeScript
  'as',
  'async',
  'await',
  'export',
  'extends',
  'from',
  'function',
  'import',
  'in',
  'instanceof',
  'let',
  'of',
  'super',
  'typeof',
  'var',
  'with',
  'yield',
  'undefined',
  'null',
  'get',
  'set',
  'static',
  'this',
  // Python
  'and',
  'assert',
  'def',
  'del',
  'elif',
  'global',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'is',
  'None',
  'True',
  'False',
  // Go
  'chan',
  'defer',
  'go',
  'map',
  'range',
  'type',
  'func',
  'interface',
  'package',
  // Rust
  'fn',
  'mut',
  'match',
  'impl',
  'use',
  'pub',
  'crate',
  'mod',
  'trait',
  'where',
  'loop',
  'move',
  'ref',
  'dyn',
  // Shell
  'fi',
  'esac',
  'done',
  // SQL
  'insert',
  'update',
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'group',
  'order',
  'having',
  'union',
  'values',
  'create',
  'table',
  'index',
  'view',
  'begin',
  'commit',
  'rollback',
  'drop',
  'alter',
  'primary',
  'foreign',
  'references',
  'select',
])

/** `#word` that is a preprocessor directive rather than a comment (`#x` in Ruby). */
const PREPROCESSORS = new Set<string>([
  'include',
  'include_next',
  'define',
  'undef',
  'ifdef',
  'ifndef',
  'if',
  'elif',
  'else',
  'endif',
  'error',
  'warning',
  'line',
  'pragma',
  'import',
  'region',
  'endregion',
])

const WORD_START = /[A-Za-z_$]/
const WORD_PART = /[A-Za-z0-9_$]/

function isWordStart(char: string): boolean {
  // Identifiers in any script: a Myanmar function name is a word too.
  return WORD_START.test(char) || char.charCodeAt(0) > 127
}

function isWordPart(char: string): boolean {
  return WORD_PART.test(char) || char.charCodeAt(0) > 127
}

/**
 * The snippet split into coloured tokens. Concatenating every `text` gives
 * the input back exactly, whitespace included.
 */
export function tokenizeCode(text: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const push = (raw: string, kind: TokenKind): void => {
    if (raw.length === 0) return
    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.kind === kind) last.text += raw
    else tokens.push({ text: raw, kind })
  }

  let i = 0
  while (i < text.length) {
    const char = text[i]
    const next = i + 1 < text.length ? text[i + 1] : ''

    // Comments first: a `//` outranks anything the same characters could
    // mean as code (`a // b` is never division twice).
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      push(text.slice(i, stop), 'comment')
      i = stop
      continue
    }
    if (char === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      const stop = close === -1 ? text.length : close + 2
      push(text.slice(i, stop), 'comment')
      i = stop
      continue
    }
    if (char === '#') {
      const word = /^#[A-Za-z]+/.exec(text.slice(i))
      if (next === '!' || next === '' || next === ' ' || next === '\t') {
        const end = text.indexOf('\n', i)
        const stop = end === -1 ? text.length : end
        push(text.slice(i, stop), 'comment')
        i = stop
        continue
      }
      if (word !== null && PREPROCESSORS.has(word[0].slice(1).toLowerCase())) {
        push(word[0], 'keyword')
        i += word[0].length
        continue
      }
      // Any other `#` opens a comment in Python, Ruby and the shell.
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      push(text.slice(i, stop), 'comment')
      i = stop
      continue
    }

    // Strings: triple quotes before the single ones, backticks allowed to
    // span lines (a template literal does), the rest stopping at the newline
    // an unterminated quote cannot cross.
    if (char === '"' || char === "'" || char === '`') {
      const triple = text.slice(i, i + 3) === char.repeat(3)
      const quote = triple ? char.repeat(3) : char
      let j = i + quote.length
      for (;;) {
        if (j >= text.length) break
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text.startsWith(quote, j)) {
          j += quote.length
          break
        }
        if (!triple && quote !== '`' && text[j] === '\n') break
        j += 1
      }
      push(text.slice(i, j), 'string')
      i = j
      continue
    }

    if (char >= '0' && char <= '9') {
      let j = i + 1
      while (j < text.length && /[0-9a-zA-Z_.]/.test(text[j])) j += 1
      push(text.slice(i, j), 'number')
      i = j
      continue
    }

    if (isWordStart(char)) {
      let j = i + 1
      while (j < text.length && isWordPart(text[j])) j += 1
      const word = text.slice(i, j)
      // `.` immediately before (skipping nothing: a member sits tight) — a
      // property is never a keyword, whatever it is spelled.
      const member = i > 0 && text[i - 1] === '.'
      let k = j
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k += 1
      const calls = text[k] === '('
      const kind: TokenKind = member
        ? calls
          ? 'function'
          : 'plain'
        : KEYWORDS.has(word)
          ? 'keyword'
          : calls
            ? 'function'
            : 'plain'
      push(word, kind)
      i = j
      continue
    }

    // Whitespace and punctuation: plain, merged with whatever is adjacent.
    push(char, 'plain')
    i += 1
  }
  return tokens
}

/** The stylesheet class a token kind wears in HTML and EPUB (`null` = plain). */
export function tokenClass(kind: TokenKind): string | null {
  switch (kind) {
    case 'comment':
      return 'tok-c'
    case 'string':
      return 'tok-s'
    case 'number':
      return 'tok-n'
    case 'keyword':
      return 'tok-k'
    case 'function':
      return 'tok-f'
    default:
      return null
  }
}

/** The run colour a token kind wears in DOCX (`null` = the block's own). */
export function tokenColor(kind: TokenKind): string | null {
  switch (kind) {
    case 'comment':
      return '008000'
    case 'string':
      return 'A31515'
    case 'number':
      return '098658'
    case 'keyword':
      return '0000FF'
    case 'function':
      return '795E26'
    default:
      return null
  }
}

/**
 * The five `.tok-*` rules, ready to drop into a stylesheet.
 *
 * One palette for every format — an HTML export, an EPUB and a DOCX printed
 * side by side must tell the same story. VS Code's light theme values: they
 * read clearly on the white page exports draw and survive a colour printer.
 */
export function tokenCssRules(): string {
  const rule = (cls: string, kind: TokenKind): string =>
    `  .${cls} { color: #${tokenColor(kind)}; }`
  return [
    '/* Syntax colouring re-derived from the text (src/export/highlight.ts). */',
    rule('tok-c', 'comment'),
    rule('tok-s', 'string'),
    rule('tok-n', 'number'),
    rule('tok-k', 'keyword'),
    rule('tok-f', 'function'),
  ].join('\n')
}

/**
 * The snippet as HTML: every token escaped inside its own span, plain text
 * unwrapped so a snippet with no recognisable token is byte-for-byte the
 * escaped input.
 */
export function highlightHtml(text: string): string {
  return tokenizeCode(text)
    .map((token) => {
      const cls = tokenClass(token.kind)
      const escaped = escapeHtml(token.text)
      return cls === null ? escaped : `<span class="${cls}">${escaped}</span>`
    })
    .join('')
}
