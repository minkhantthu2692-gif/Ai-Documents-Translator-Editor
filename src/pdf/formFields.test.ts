/**
 * Form-field labels.
 *
 * Three things are tested separately because they fail differently: what a
 * widget contributes is a reading of the PDF spec, where it lands is geometry,
 * and what the block looks like is a presentation decision that every exporter
 * inherits. `pdfExtract.test.ts` then drives the whole thing against
 * `fixtures/form.pdf`, which is written by hand so every rectangle in it is
 * exact.
 */
import { describe, expect, it } from 'vitest'
import { attachFieldLabels, fieldLabels, type FieldLabel } from './formFields'
import { tokenizePlaceholders } from './placeholders'
import type { BBox } from './stableId'
import type { PageBlock } from './structure'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

function block(order: number, text: string, bbox: BBox, extra: Partial<PageBlock> = {}): PageBlock {
  return {
    id: `block-${order}`,
    kind: 'paragraph',
    region: 'body',
    order,
    text,
    bbox,
    lines: [],
    alignment: 'left',
    skipRule: null,
    placeholders: [],
    listMarker: null,
    tableCells: null,
    tableSpans: null,
    headingLevel: null,
    links: [],
    figures: [],
    lineSpacing: 1.4,
    fontFamily: 'Helvetica',
    fontSize: 10,
    bold: false,
    italic: false,
    color: '#000000',
    ...extra,
  }
}

const attach = (blocks: PageBlock[], labels: FieldLabel[], ctx?: { targetLang?: string }) =>
  attachFieldLabels(blocks, labels, {
    pageIndex: 0,
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
    ctx,
  })

/** The three printed labels of the fixture's first page, at 40 pt row pitch. */
function printedRows(): PageBlock[] {
  return [
    block(0, 'Full Name:', { x: 72, y: 204, w: 48, h: 10 }),
    block(1, 'Date of Birth:', { x: 72, y: 244, w: 58, h: 10 }),
    block(2, 'Country:', { x: 72, y: 284, w: 38, h: 10 }),
  ]
}

describe('fieldLabels', () => {
  it('reads /TU off a widget and flips its rectangle into page space', () => {
    const labels = fieldLabels(
      [
        {
          subtype: 'Widget',
          alternativeText: 'Full name of the applicant',
          rect: [180, 530, 340, 546],
        },
      ],
      PAGE_HEIGHT,
    )
    expect(labels).toHaveLength(1)
    // PDF rects are bottom-left origin: 792 − 546 = 246, 792 − 530 = 262.
    expect(labels[0].widget).toEqual({ x: 180, y: 246, w: 160, h: 16 })
    expect(labels[0].text).toBe('Full name of the applicant')
  })

  it("follows a choice field's caption with its options, in document order", () => {
    const labels = fieldLabels(
      [
        {
          subtype: 'Widget',
          alternativeText: 'Country of residence',
          rect: [180, 490, 340, 506],
          options: [
            { exportValue: 'MM', displayValue: 'Myanmar' },
            { exportValue: 'TH', displayValue: 'Thailand' },
          ],
        },
      ],
      PAGE_HEIGHT,
    )
    expect(labels[0].text).toBe('Country of residence\nMyanmar\nThailand')
  })

  it('takes the options even when the field has no description at all', () => {
    const labels = fieldLabels(
      [
        {
          subtype: 'Widget',
          rect: [72, 400, 200, 420],
          options: [{ exportValue: 'a', displayValue: 'Yes' }, null],
        },
      ],
      PAGE_HEIGHT,
    )
    expect(labels).toHaveLength(1)
    expect(labels[0].text).toBe('Yes')
  })

  it('ignores links, hidden fields and widgets with nothing to say', () => {
    expect(fieldLabels(undefined, PAGE_HEIGHT)).toEqual([])
    expect(fieldLabels([], PAGE_HEIGHT)).toEqual([])
    // A `/Link` rectangle is not a field, whatever it covers.
    expect(fieldLabels([{ subtype: 'Link', rect: [0, 0, 10, 10] }], PAGE_HEIGHT)).toEqual([])
    // A hidden field is announced to nobody, so its `/TU` is a designer's note.
    expect(
      fieldLabels(
        [
          {
            subtype: 'Widget',
            hidden: true,
            alternativeText: 'Internal reference',
            rect: [0, 0, 90, 16],
          },
        ],
        PAGE_HEIGHT,
      ),
    ).toEqual([])
    // A push button, a bare signature line, an undescribed text box.
    expect(fieldLabels([{ subtype: 'Widget', rect: [0, 0, 90, 16] }], PAGE_HEIGHT)).toEqual([])
    expect(
      fieldLabels(
        [{ subtype: 'Widget', alternativeText: '   ', rect: [0, 0, 90, 16] }],
        PAGE_HEIGHT,
      ),
    ).toEqual([])
  })

  it('refuses a rectangle that has no area', () => {
    expect(
      fieldLabels(
        [{ subtype: 'Widget', alternativeText: 'Label', rect: [10, 10, 10, 40] }],
        PAGE_HEIGHT,
      ),
    ).toEqual([])
    expect(fieldLabels([{ subtype: 'Widget', alternativeText: 'Label' }], PAGE_HEIGHT)).toEqual([])
  })

  it('reports two identical widgets as the one field they are', () => {
    const widget = { subtype: 'Widget', alternativeText: 'Same words', rect: [72, 400, 200, 420] }
    expect(fieldLabels([widget, { ...widget }], PAGE_HEIGHT)).toHaveLength(1)
    // …but two widgets at different places stay two.
    expect(
      fieldLabels([widget, { ...widget, rect: [72, 300, 200, 320] }], PAGE_HEIGHT),
    ).toHaveLength(2)
  })
})

describe('attachFieldLabels', () => {
  it('hands back the page untouched when there is nothing to add', () => {
    const blocks = printedRows()
    expect(attach(blocks, [])).toBe(blocks)
    expect(blocks.map((entry) => entry.order)).toEqual([0, 1, 2])
  })

  it('drops each description in after the row it belongs to and renumbers', () => {
    const labels: FieldLabel[] = [
      { widget: { x: 180, y: 246, w: 160, h: 16 }, text: 'Date of birth, day month year' },
      { widget: { x: 180, y: 206, w: 220, h: 16 }, text: 'Full name of the applicant' },
    ]
    const merged = attach(printedRows(), labels)
    expect(merged.map((entry) => entry.text)).toEqual([
      'Full Name:',
      'Full name of the applicant',
      'Date of Birth:',
      'Date of birth, day month year',
      'Country:',
    ])
    expect(merged.map((entry) => entry.order)).toEqual([0, 1, 2, 3, 4])
  })

  it('marks what it adds as a body block of the form-field kind', () => {
    const merged = attach(printedRows(), [
      { widget: { x: 180, y: 246, w: 160, h: 16 }, text: 'Date of birth, day month year' },
    ])
    const created = merged.find((entry) => entry.kind === 'form-field')
    expect(created).toBeDefined()
    expect(created?.kind).toBe('form-field')
    expect(created?.region).toBe('body')
    expect(created?.headingLevel).toBeNull()
    expect(created?.listMarker).toBeNull()
    expect(created?.tableCells).toBeNull()
    expect(created?.links).toEqual([])
    expect(created?.figures).toEqual([])
    // Prose must reach the model: a form description is content, not chrome.
    expect(created?.skipRule).toBeNull()
  })

  it('never rewrites, re-links or re-anchors the printed blocks', () => {
    const before = printedRows()
    const linked = block(
      0,
      'Full Name:',
      { x: 72, y: 204, w: 48, h: 10 },
      {
        links: [{ text: 'Name', url: 'https://example.com' }],
        figures: [{ bbox: { x: 72, y: 180, w: 40, h: 20 }, pixelWidth: 4, pixelHeight: 4 }],
      },
    )
    const merged = attach(
      [linked, ...before.slice(1)],
      [{ widget: { x: 180, y: 246, w: 160, h: 16 }, text: 'Date of birth, day month year' }],
    )
    expect(merged[0].text).toBe('Full Name:')
    expect(merged[0].links).toEqual([{ text: 'Name', url: 'https://example.com' }])
    expect(merged[0].figures).toHaveLength(1)
    expect(before.every((entry) => entry.kind === 'paragraph')).toBe(true)
  })

  it('hangs the box under its own widget and grows it to hold every line', () => {
    const merged = attach(printedRows(), [
      { widget: { x: 180, y: 246, w: 160, h: 16 }, text: 'Date of birth, day month year' },
      {
        widget: { x: 180, y: 286, w: 160, h: 16 },
        text: 'Country of residence\nMyanmar\nThailand\nViet Nam\nLao PDR',
      },
      // 12 pt checkbox: a caption the width of the box alone would be a
      // sliver, so the width has to come from the text.
      { widget: { x: 72, y: 328, w: 12, h: 12 }, text: 'I have read and accept the terms' },
    ])
    const [underBox, options, besideCheckbox] = merged.filter(
      (entry) => entry.kind === 'form-field',
    )

    expect(underBox.bbox.x).toBe(180)
    expect(underBox.bbox.y).toBe(262) // 246 + the box's own height
    expect(underBox.bbox.w).toBeGreaterThanOrEqual(160)
    expect(underBox.lines).toHaveLength(1)

    // Five captions must not be squeezed into a 16 pt box.
    expect(options.bbox.y).toBe(302)
    expect(options.bbox.h).toBeGreaterThan(16 * 4)
    expect(options.lines.map((line) => line.text)).toEqual([
      'Country of residence',
      'Myanmar',
      'Thailand',
      'Viet Nam',
      'Lao PDR',
    ])

    expect(besideCheckbox.bbox.x).toBe(72)
    expect(besideCheckbox.bbox.y).toBe(340)
    expect(besideCheckbox.bbox.w).toBeGreaterThan(100)
    expect(besideCheckbox.bbox.w).toBeLessThanOrEqual(PAGE_WIDTH - 72 - 12)
  })

  it('moves above the widget when the page has no room left below it', () => {
    const merged = attach(
      [],
      [{ widget: { x: 72, y: 770, w: 200, h: 16 }, text: 'Signed here' }],
      {},
    )
    const created = merged[0]
    expect(created.bbox.y + created.bbox.h).toBeLessThanOrEqual(PAGE_HEIGHT)
    expect(created.bbox.y).toBeLessThan(770)
  })

  it('starts a page that has no text at all', () => {
    const merged = attach(
      [],
      [{ widget: { x: 72, y: 100, w: 200, h: 16 }, text: 'Only a field here' }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].order).toBe(0)
    expect(merged[0].text).toBe('Only a field here')
  })

  it('borrows its face from the row it joins and its colour from nowhere', () => {
    const rows = [
      block(
        0,
        'Full Name:',
        { x: 72, y: 204, w: 48, h: 10 },
        {
          fontFamily: 'Times',
          fontSize: 14,
          color: '#101010',
        },
      ),
    ]
    const created = attach(rows, [
      { widget: { x: 180, y: 206, w: 220, h: 16 }, text: 'A description' },
    ]).find((entry) => entry.kind === 'form-field')
    expect(created?.fontFamily).toBe('Times')
    expect(created?.fontSize).toBe(14)
    // Descriptions are never the page's own colour: they would read as a
    // second copy of the label beside them.
    expect(created?.color).toBe('#6b7280')
    expect(created?.italic).toBe(true)
    expect(created?.bold).toBe(false)
    expect(rows[0].fontSize).toBe(14)
  })

  it('applies the same skip rules and placeholders as printed text', () => {
    const email = attach(printedRows(), [
      { widget: { x: 180, y: 246, w: 160, h: 16 }, text: 'support@example.com' },
    ]).find((entry) => entry.kind === 'form-field')
    expect(email?.skipRule).toBe('email')

    const source = 'Room size (x + y = 10) metres'
    const tokenised = attach(printedRows(), [
      { widget: { x: 180, y: 246, w: 160, h: 16 }, text: source },
    ]).find((entry) => entry.kind === 'form-field')
    expect(tokenised?.placeholders).toEqual(tokenizePlaceholders(source).placeholders)
    expect(tokenised?.placeholders.map((entry) => entry.original)).toEqual(['(x + y = 10)'])

    // The project context reaches the rule too: a tooltip somebody has
    // already written in Burmese is not sent back out for translation.
    const alreadyMine = attach(
      printedRows(),
      [{ widget: { x: 180, y: 246, w: 160, h: 16 }, text: 'မြန်မာနိုင်ငံ ဒီမိုကရေစီ' }],
      { targetLang: 'my' },
    ).find((entry) => entry.kind === 'form-field')
    expect(alreadyMine?.skipRule).toBe('alreadyTarget')
  })
})
