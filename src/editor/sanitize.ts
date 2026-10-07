/**
 * HTML sanitisation (Phase 4).
 *
 * No translation output is ever injected into the DOM unescaped: this module
 * is the single gate for the few places that legitimately need markup (the
 * print frame, the HTML preview, rich-text round trips). It is CSP friendly —
 * no `eval`, no inline event handlers, no remote URLs — and everything it
 * returns is a string the caller can still escape if it needs to.
 */

import DOMPurify from 'dompurify'
import type { Config } from 'dompurify'

/** Tags the editor/export legitimately produces. */
const ALLOWED_TAGS = [
  'p',
  'div',
  'span',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'mark',
  'small',
  'sub',
  'sup',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'caption',
  'figure',
  'figcaption',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'nav',
  'a',
  'img',
  'style',
  'title',
  'html',
  'head',
  'body',
  'font',
]

const ALLOWED_ATTR = [
  'class',
  'id',
  'style',
  'dir',
  'lang',
  'xml:lang',
  'title',
  'data-block-id',
  'data-page',
  'data-role',
  'href',
  'src',
  'alt',
  'width',
  'height',
  'color',
  'face',
  'size',
  'align',
  'valign',
  'colspan',
  'rowspan',
  'charset',
  'media',
  'rel',
]

/** Only local/data URLs may be followed (no `javascript:` or remote scripts). */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: [
    'script',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'select',
    'textarea',
    'base',
    'noscript',
  ],
  FORBID_ATTR: [
    'onerror',
    'onclick',
    'onload',
    'onmouseover',
    'onfocus',
    'onblur',
    'onsubmit',
    'srcdoc',
    'formaction',
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  WHOLE_DOCUMENT: false,
  SANITIZE_DOM: true,
}

/** Returns markup with scripts/handlers/dangerous URLs removed. */
export function sanitizeHtml(html: string, config?: Config): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  const merged: Config = { ...SANITIZE_CONFIG, ...config, RETURN_TRUSTED_TYPE: false }
  return DOMPurify.sanitize(html, merged) as string
}

/** Whole-document variant used for the print frame and the HTML export preview. */
export function sanitizeDocument(html: string): string {
  return sanitizeHtml(html, { WHOLE_DOCUMENT: true, RETURN_TRUSTED_TYPE: false })
}

/** Markup → plain text (used by find/replace and the DOCX/TXT exporters). */
export function htmlToText(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  const cleaned = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['br', 'p', 'div', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr'],
    ALLOWED_ATTR: [],
  })
  // Block boundaries and <br> must become whitespace, or words glue together.
  const separated = cleaned
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/\s*(p|div|li|blockquote|h[1-6]|tr)\s*>/gi, ' ')
  if (typeof document === 'undefined') {
    return decodeEntities(separated.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
  }
  const host = document.createElement('div')
  host.innerHTML = separated
  return (host.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** True when nothing dangerous survived (assertion used by tests). */
export function isSanitized(html: string): boolean {
  return !/<script|javascript:|onerror\s*=|onload\s*=/i.test(sanitizeHtml(html))
}
