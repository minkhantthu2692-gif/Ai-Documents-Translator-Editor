/**
 * Translation language list — shared by the new-project wizard, the translate
 * page and anywhere else a source/target language is picked.
 *
 * `value` is the ISO-639-1 code used everywhere in the app (project records,
 * glossaries, translation memory, prompts). `label` is the English name and
 * `native` the endonym, so a dropdown reads "Burmese — မြန်မာ".
 */

export interface LanguageOption {
  value: string
  label: string
  native: string
  /** Written right-to-left (rendering + prompt hints). */
  rtl?: boolean
}

export const LANGUAGES: LanguageOption[] = [
  { value: 'my', label: 'Burmese', native: 'မြန်မာ' },
  { value: 'en', label: 'English', native: 'English' },
  { value: 'zh', label: 'Chinese (Simplified)', native: '简体中文' },
  { value: 'zh-Hant', label: 'Chinese (Traditional)', native: '繁體中文' },
  { value: 'th', label: 'Thai', native: 'ไทย' },
  { value: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { value: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { value: 'ms', label: 'Malay', native: 'Bahasa Melayu' },
  { value: 'fil', label: 'Filipino', native: 'Filipino' },
  { value: 'ja', label: 'Japanese', native: '日本語' },
  { value: 'ko', label: 'Korean', native: '한국어' },
  { value: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { value: 'bn', label: 'Bengali', native: 'বাংলা' },
  { value: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { value: 'te', label: 'Telugu', native: 'తెలుగు' },
  { value: 'mr', label: 'Marathi', native: 'मराठी' },
  { value: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
  { value: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ' },
  { value: 'ml', label: 'Malayalam', native: 'മലയാളം' },
  { value: 'ne', label: 'Nepali', native: 'नेपाली' },
  { value: 'si', label: 'Sinhala', native: 'සිංහල' },
  { value: 'km', label: 'Khmer', native: 'ភាសាខ្មែរ' },
  { value: 'lo', label: 'Lao', native: 'ລາວ' },
  { value: 'ka', label: 'Georgian', native: 'ქართული' },
  { value: 'hy', label: 'Armenian', native: 'Հայերեն' },
  { value: 'ar', label: 'Arabic', native: 'العربية', rtl: true },
  { value: 'fa', label: 'Persian', native: 'فارسی', rtl: true },
  { value: 'ur', label: 'Urdu', native: 'اردو', rtl: true },
  { value: 'he', label: 'Hebrew', native: 'עברית', rtl: true },
  { value: 'ps', label: 'Pashto', native: 'پښتو', rtl: true },
  { value: 'ku', label: 'Kurdish (Kurmanji)', native: 'Kurdî' },
  { value: 'tr', label: 'Turkish', native: 'Türkçe' },
  { value: 'az', label: 'Azerbaijani', native: 'Azərbaycanca' },
  { value: 'kk', label: 'Kazakh', native: 'Қазақша' },
  { value: 'uz', label: 'Uzbek', native: "O'zbekcha" },
  { value: 'mn', label: 'Mongolian', native: 'Монгол' },
  { value: 'ru', label: 'Russian', native: 'Русский' },
  { value: 'uk', label: 'Ukrainian', native: 'Українська' },
  { value: 'pl', label: 'Polish', native: 'Polski' },
  { value: 'cs', label: 'Czech', native: 'Čeština' },
  { value: 'sk', label: 'Slovak', native: 'Slovenčina' },
  { value: 'hu', label: 'Hungarian', native: 'Magyar' },
  { value: 'ro', label: 'Romanian', native: 'Română' },
  { value: 'bg', label: 'Bulgarian', native: 'Български' },
  { value: 'sr', label: 'Serbian', native: 'Српски' },
  { value: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { value: 'sl', label: 'Slovenian', native: 'Slovenščina' },
  { value: 'el', label: 'Greek', native: 'Ελληνικά' },
  { value: 'de', label: 'German', native: 'Deutsch' },
  { value: 'fr', label: 'French', native: 'Français' },
  { value: 'es', label: 'Spanish', native: 'Español' },
  { value: 'pt', label: 'Portuguese', native: 'Português' },
  { value: 'it', label: 'Italian', native: 'Italiano' },
  { value: 'nl', label: 'Dutch', native: 'Nederlands' },
  { value: 'sv', label: 'Swedish', native: 'Svenska' },
  { value: 'da', label: 'Danish', native: 'Dansk' },
  { value: 'nb', label: 'Norwegian', native: 'Norsk' },
  { value: 'fi', label: 'Finnish', native: 'Suomi' },
  { value: 'is', label: 'Icelandic', native: 'Íslenska' },
  { value: 'et', label: 'Estonian', native: 'Eesti' },
  { value: 'lv', label: 'Latvian', native: 'Latviešu' },
  { value: 'lt', label: 'Lithuanian', native: 'Lietuvių' },
  { value: 'ga', label: 'Irish', native: 'Gaeilge' },
  { value: 'cy', label: 'Welsh', native: 'Cymraeg' },
  { value: 'af', label: 'Afrikaans', native: 'Afrikaans' },
  { value: 'sw', label: 'Swahili', native: 'Kiswahili' },
  { value: 'am', label: 'Amharic', native: 'አማርኛ' },
  { value: 'ha', label: 'Hausa', native: 'Hausa' },
  { value: 'yo', label: 'Yoruba', native: 'Yorùbá' },
  { value: 'ig', label: 'Igbo', native: 'Igbo' },
  { value: 'zu', label: 'Zulu', native: 'isiZulu' },
  { value: 'sq', label: 'Albanian', native: 'Shqip' },
  { value: 'mk', label: 'Macedonian', native: 'Македонски' },
  { value: 'bs', label: 'Bosnian', native: 'Bosanski' },
  { value: 'ca', label: 'Catalan', native: 'Català' },
  { value: 'eu', label: 'Basque', native: 'Euskara' },
  { value: 'gl', label: 'Galician', native: 'Galego' },
  { value: 'la', label: 'Latin', native: 'Latina' },
]

/** ISO code → option (undefined when the code is not in the list). */
export function languageOption(value: string | null | undefined): LanguageOption | undefined {
  if (!value) return undefined
  return LANGUAGES.find((language) => language.value === value)
}

/** `Burmese (မြန်မာ)` — falls back to the raw code for unknown languages. */
export function languageLabel(value: string): string {
  const option = languageOption(value)
  return option ? `${option.label} (${option.native})` : value
}

/** Dropdown options in the shape the Select primitive expects. */
export function languageSelectOptions(): Array<{ value: string; label: string }> {
  return LANGUAGES.map((language) => ({
    value: language.value,
    label: `${language.label} — ${language.native}`,
  }))
}
