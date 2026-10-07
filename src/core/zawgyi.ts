/**
 * Zawgyi detection and Zawgyi → Unicode conversion.
 *
 * Myanmar text exists in two incompatible encodings: standard Unicode Myanmar
 * and the legacy Zawgyi font encoding. OCR output and old PDFs frequently come
 * back as Zawgyi, which would render as mojibake with our bundled Unicode fonts,
 * so analysis converts it automatically after detection.
 *
 * Detection uses a two-state-set Markov model and conversion uses eight ordered
 * transliteration phases — both ported from Google's `myanmar-tools`
 * (https://github.com/googlei18n/myanmar-tools), Copyright 2017 Google LLC,
 * licensed under the Apache License, Version 2.0. Rules live in
 * `zawgyiRulesZ2U.ts`, the model payload in `zawgyiModelData.ts`.
 */

import { ZAWGYI_MODEL_BASE64 } from './zawgyiModelData'
import { getAllRulesZ2U, type TranslitRule } from './zawgyiRulesZ2U'

/* -------------------------------------------------------------------------- */
/* Conversion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Applies one phase: repeatedly matches the earliest applicable rule against
 * the unconsumed remainder, appending converted text to the output.
 */
function runPhase(rules: TranslitRule[], input: string): string {
  let out = ''
  let rest = input
  let startOfString = true

  while (rest.length > 0) {
    let matched = false
    for (const rule of rules) {
      if (rule.matchOnStart != null && !startOfString) continue
      const m = rest.match(rule.p)
      if (!m) continue
      matched = true
      const rightPartSize = rest.length - m[0].length
      rest = rest.replace(rule.p, rule.s)
      const newStart = rest.length - rightPartSize
      if (rule.revisit == null) {
        out += rest.substring(0, newStart)
        rest = rest.substring(newStart)
      }
    }
    if (!matched) {
      out += rest[0]
      rest = rest.substring(1)
    }
    startOfString = false
  }
  return out
}

function runAllPhases(allRules: TranslitRule[][], input: string): string {
  let out = input
  for (const rules of allRules) out = runPhase(rules, out)
  return out
}

/**
 * Converts Zawgyi-encoded Myanmar text to standard Unicode Myanmar.
 * Text that is already Unicode passes through unchanged (the rules are written
 * so that standard sequences are idempotent).
 */
export function zawgyiToUnicode(input: string): string {
  if (!input) return input
  return runAllPhases(getAllRulesZ2U(), input)
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

const STD_CP0 = 0x1000
const STD_CP1 = 0x103f
const AFT_CP0 = 0x104a
const AFT_CP1 = 0x109f
const EXA_CP0 = 0xaa60
const EXA_CP1 = 0xaa7f
const EXB_CP0 = 0xa9e0
const EXB_CP1 = 0xa9ff
const SPC_CP0 = 0x2000
const SPC_CP1 = 0x200b

const STD_OFFSET = 1
const AFT_OFFSET = STD_OFFSET + (STD_CP1 - STD_CP0 + 1)
const EXA_OFFSET = AFT_OFFSET + (AFT_CP1 - AFT_CP0 + 1)
const EXB_OFFSET = EXA_OFFSET + (EXA_CP1 - EXA_CP0 + 1)
const SPC_OFFSET = EXB_OFFSET + (EXB_CP1 - EXB_CP0 + 1)
const SSV_STD_EXA_EXB_SPC = 0

/** Maps a code point onto its Markov state (0 = "no signal"). */
function stateForCodePoint(cp: number, ssv: number): number {
  if (cp >= STD_CP0 && cp <= STD_CP1) return cp - STD_CP0 + STD_OFFSET
  if (cp >= AFT_CP0 && cp <= AFT_CP1) return cp - AFT_CP0 + AFT_OFFSET
  if (cp >= EXA_CP0 && cp <= EXA_CP1) return cp - EXA_CP0 + EXA_OFFSET
  if (cp >= EXB_CP0 && cp <= EXB_CP1) return cp - EXB_CP0 + EXB_OFFSET
  if (ssv === SSV_STD_EXA_EXB_SPC && cp >= SPC_CP0 && cp <= SPC_CP1) {
    return cp - SPC_CP0 + SPC_OFFSET
  }
  return 0
}

/** Sparse log-probability matrix decoded from the binary model payload. */
class BinaryMarkov {
  private readonly rows: Float32Array[]

  constructor(stream: DataView, offset: number) {
    // Browser build: 8-byte binary tag + 4-byte serial version are not checked.
    offset += 12
    const size = stream.getInt16(offset)
    offset += 2
    const rows: Float32Array[] = []
    for (let i = 0; i < size; i += 1) {
      const row = new Float32Array(size)
      let entries = stream.getInt16(offset)
      offset += 2
      let fallback = 0
      if (entries !== 0) {
        fallback = stream.getFloat32(offset)
        offset += 4
      }
      let next = -1
      for (let j = 0; j < size; j += 1) {
        if (entries > 0 && next < j) {
          next = stream.getInt16(offset)
          offset += 2
          entries -= 1
        }
        if (next === j) {
          row[j] = stream.getFloat32(offset)
          offset += 4
        } else {
          row[j] = fallback
        }
      }
      rows.push(row)
    }
    this.rows = rows
  }

  difference(from: number, to: number): number {
    return this.rows[from][to]
  }
}

interface MarkovModel {
  classifier: BinaryMarkov
  ssv: number
}

function decodeModel(base64: string): MarkovModel {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i += 1) view[i] = binary.charCodeAt(i)

  const stream = new DataView(buffer)
  let offset = 0
  // ZawgyiUnicodeMarkovModel: 8-byte tag, then serial version (1 = no SSV field).
  offset += 8
  const version = stream.getUint32(offset)
  offset += 4
  let ssv = 0
  if (version === 2) {
    ssv = stream.getUint32(offset)
    offset += 4
  } else if (version !== 1) {
    throw new Error(`Unsupported zawgyi model version: ${version}`)
  }
  return { classifier: new BinaryMarkov(stream, offset), ssv }
}

let cachedModel: MarkovModel | null = null

function model(): MarkovModel {
  if (!cachedModel) cachedModel = decodeModel(ZAWGYI_MODEL_BASE64)
  return cachedModel
}

/**
 * Probability that `input` is Zawgyi given it is either Zawgyi or Unicode.
 * Approaches 1 for strong Zawgyi, 0 for strong Unicode, and returns
 * `-Infinity` when the input has no Myanmar-range code points at all.
 */
export function zawgyiProbability(input: string): number {
  if (!input) return Number.NEGATIVE_INFINITY
  const { classifier, ssv } = model()
  let prevState = 0
  let totalDelta = 0
  let seenTransition = false

  for (let offset = 0; offset <= input.length; offset += 1) {
    const currState = offset === input.length ? 0 : stateForCodePoint(input.charCodeAt(offset), ssv)
    if (prevState !== 0 || currState !== 0) {
      totalDelta += classifier.difference(prevState, currState)
      seenTransition = true
    }
    prevState = currState
  }

  if (!seenTransition) return Number.NEGATIVE_INFINITY
  // Pz / (Pu + Pz) computed in log space.
  return 1 / (1 + Math.exp(totalDelta))
}

/** True when the text looks like legacy Zawgyi encoding. */
export function isLikelyZawgyi(input: string, threshold = 0.5): boolean {
  const probability = zawgyiProbability(input)
  if (Number.isNaN(probability) || probability === Number.NEGATIVE_INFINITY) return false
  return probability >= threshold
}

export interface UnicodeRepairResult {
  text: string
  /** True when a conversion actually changed the string. */
  converted: boolean
  /** Zawgyi probability measured on the input (0 when there is no signal). */
  probability: number
  /** True when the input was recognised as Zawgyi and therefore converted. */
  wasZawgyi: boolean
}

/**
 * Auto-conversion entry point used by analysis: when the sample reads as
 * Zawgyi, return the Unicode form; otherwise pass the text through untouched.
 */
export function ensureUnicode(input: string): UnicodeRepairResult {
  const probability = zawgyiProbability(input)
  const scored =
    Number.isNaN(probability) || probability === Number.NEGATIVE_INFINITY ? 0 : probability
  const wasZawgyi = scored >= 0.5
  if (!wasZawgyi) return { text: input, converted: false, probability: scored, wasZawgyi }
  const convertedText = zawgyiToUnicode(input)
  return {
    text: convertedText,
    converted: convertedText !== input,
    probability: scored,
    wasZawgyi,
  }
}
