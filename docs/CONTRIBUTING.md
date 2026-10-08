# Contributing

Thanks for helping with **AI Documents Translator & Editor**. This document is the contract:
how to set up, how to write code, and what must pass before a change is considered done.

## Getting started

```bash
git clone https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor.git
cd Ai-Documents-Translator-Editor
npm install
npm run dev            # http://localhost:5173
```

- Node.js ≥ 18 (20 recommended).
- `cp .env.example .env` only if you are working on sync or the assistant (everything else
  runs without it).
- On Windows/macOS the `tools/open-app.*` scripts do the checks and start the server for you;
  `tools/launcher.html` is a bilingual checklist with copy buttons.
- Tests need no network: `npm test` runs entirely offline.

## Branches and commits

- Branch from `main`; open pull requests against `main`.
- Commit style is conventional-ish, one line, imperative, plain English:

  ```text
  fix: resume the queue after a mid-run refresh
  feat(sync): paged pull with last-write-wins merge
  docs: describe the VITE_BASE workflow
  test(pdf): cover the no-text-layer preflight path
  chore: bump the service worker cache version
  ```

- Scope in parentheses is optional. A short body explaining *why* is always welcome.
- Never commit `.env`, keys, tokens or personal notes (`.gitignore` already covers them; the
  `tools/push-to-github.*` helpers re-verify that before pushing).

## The full gate

Run this before **every** commit and before every pull request:

```bash
npx tsc --noEmit          # types
npx eslint .              # lint
npx prettier --check .    # formatting (.md is ignored by .prettierignore)
npx vitest run            # unit tests
npm run build             # tsc --noEmit && vite build
npm run dev &             # in a second terminal, on :5173
npm run smoke             # CDP smoke test against the running dev server
```

CI runs the first five (`.github/workflows/deploy.yml`); the smoke test is local — it needs
Chrome, `fixtures/` (build with `node scripts/make-fixtures.mjs`) and the dev server.

A change is not finished until the gate is green. If a check cannot apply to your change,
say so in the PR description rather than skipping it silently.

## Code style

- **Prettier** is the formatter: **no semicolons**, single quotes, `printWidth: 100`, two-space
  indent, trailing commas everywhere, `arrowParens: always`, LF endings (`.prettierrc`).
  Run `npx prettier --write .` — `.md` files are ignored on purpose.
- **ESLint** enforces the rest (`.eslint.config.js`):
  - `no-console` — only `console.warn` / `console.error` are allowed. Never `console.log`.
  - `@typescript-eslint/no-explicit-any` — use real types or `unknown` + narrowing.
  - `consistent-type-imports` — `import type { X }` (inline type imports are auto-fixed).
  - `eqeqeq: smart`, `prefer-const`, unused args/vars must start with `_`.
  - `localStorage` is restricted: use the helpers in `src/lib/storage.ts`.
- Keep the existing structure: repositories own table access, services own business logic,
  pages stay thin. Prefer small pure modules — most of `src/translate` and `src/sync` is pure
  async code with injected transport/clock precisely so it can be tested.
- Heavy work belongs in a Web Worker; keep the main thread free, destroy workers, revoke object
  URLs.
- **No secrets in code, tests or fixtures.** Use obviously fake placeholders (`sk-…`,
  `your-token-here`, `REPLACE_ME`).

## Tests

- Location: **colocated** `*.test.ts` / `*.test.tsx` next to the code they cover (Vitest
  config includes `src/**/*.test.ts(x)`; jsdom environment, setup in `src/test/setup.ts`).
- Database tests import `fake-indexeddb/auto` as the **first** line:

  ```ts
  import 'fake-indexeddb/auto'
  ```

  then open the real Dexie schema — no mocks of Dexie itself.
- Inject the world instead of waiting on it: pass an explicit transport, fake timers/sleep or
  a virtual clock (see `executor.test.ts`, `sync.test.ts`, `resume.test.ts`). No real network,
  no real timers in tests.
- Component tests use `@testing-library/react` + `@testing-library/jest-dom`; mocks are
  restored between tests (`restoreMocks: true`).
- Aim the test at behaviour, not implementation: the ladder never drops a line, the merge
  picks the expected winner, the redactor scrubs a key-shaped string.

## i18n (English + Myanmar)

Every user-facing string goes through i18next. There are no exceptions.

1. Add the key to **both** `src/i18n/locales/en.json` and `my.json` — same path, same shape.
2. The Myanmar value must be **real Myanmar script** (U+1000–U+109F), natural prose, not a
   transliteration or a copy of the English. Product/technical names (Vite, IndexedDB,
   Apps Script, DOCX …) stay in Latin where that reads naturally.
3. Myanmar layout rules apply: line-height ≥ 1.7 for Myanmar text, no forced letter-spacing.
4. Two tests enforce this:
   - `src/i18n/coverage.test.ts` scans the source for every `t('…')` key and fails if it is
     missing from either locale (including `labelKey` / `titleKey` fields);
   - `src/i18n/locales.test.ts` proves the two files have identical structure.
5. Never concatenate translated fragments — use interpolation (`t('key', { count })`).

## `data-testid` contract

The smoke test drives the UI through `data-testid` attributes; visible text changes between
languages and refactors, testids do not.

- Add `data-testid="kebab-case-name"` to any element the smoke test or an E2E script must
  find (`wizard-next`, `password-modal`, `project-dropzone`, `translate-status`,
  `open-assistant`, …).
- Testids are **stable API**: rename only together with the scripts that use them.
- Testids are not translated and carry no user data.

## Running the smoke test

```bash
npm run dev            # terminal 1 — must be up on :5173
npm run smoke          # terminal 2
```

It launches headless Chrome over CDP (`scripts/smoke.mjs`) and checks routes, responsive
breakpoints, theme/language persistence, the PDF wizard, workspace data, reload survival and a
backup round-trip. Fix the underlying UI (or its testid) rather than weakening the assertion.

## Documentation

- New feature or changed behaviour → update the matching document in the same PR: features in
  [README.md](../README.md) (+ [README.my.md](../README.my.md)), internals in
  [ARCHITECTURE.md](ARCHITECTURE.md), security-relevant changes in [SECURITY.md](SECURITY.md),
  release notes in [CHANGELOG.md](CHANGELOG.md) under `Unreleased`.
- Guides come in pairs: `FOO.md` (English) and `FOO.my.md` (Myanmar) with the same structure
  and identical command blocks (code stays English).
- Keep lines reasonable (< 100 columns where practical) and Markdown tables well-formed —
  `.md` files are excluded from Prettier, so formatting is on you.

## Pull request checklist

- [ ] `npx tsc --noEmit` · `npx eslint .` · `npx prettier --check .` · `npx vitest run` ·
      `npm run build` all pass
- [ ] `npm run smoke` passes against a running dev server
- [ ] New strings added to **both** `en.json` and `my.json`
- [ ] Tests cover the new behaviour (with `fake-indexeddb` / injected dependencies)
- [ ] New interactive elements have a stable `data-testid`
- [ ] Docs and `CHANGELOG.md` updated where the change is user-visible
- [ ] No secrets, no `console.log`, no unrelated files in the diff
