# PROJECT: AI Documents Translator & Editor
Local-first web app: translate PDFs into the user's chosen language while preserving layout, fonts, images. Then edit and export.
Repo:
minkhantthu2692-gif
minkhantthu2692@gmail.com
https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor.git

## Stack (fixed)
Vite + React 18 + TypeScript (strict), Tailwind CSS with CSS-variable design tokens, Zustand, react-i18next (my/en), Dexie (IndexedDB), pdfjs-dist, tesseract.js, react-virtuoso, Vitest. All heavy work in Web Workers. Fonts bundled locally (Noto Sans Myanmar, Padauk, Noto Sans, Noto Serif, Roboto, Inter, Source Serif).

## Design rules
Minimalism + Flat Design, 1px borders, 4/8px spacing, rounded-md, no heavy shadows/gradients. Dark/Light/System themes, WCAG AA. Fully responsive (desktop: sidebar+main+inspector; tablet: collapsible panels; mobile: bottom tab bar). Layout fills viewport (100dvh grid, no big empty areas, panels scroll internally). Myanmar text line-height >= 1.7. Keyboard accessible, aria labels, reduced-motion support.

## Global engineering rules
- Deliver every file in full. No placeholders, no "...", no TODO comments.
- Never hardcode, log, or commit API keys. Secrets only via .env (gitignored); only VITE_-prefixed non-sensitive values reach the browser.
- Keys are stored locally only, encrypted with WebCrypto AES-GCM.
- Every UI string goes through i18n with complete Burmese and English JSON.
- Every state/transition emits an event: {timestamp, state, pageIndex, lineIndex, reasonCode, messageMy, messageEn, technicalDetail, fixActions[]}.
- Main thread must stay responsive. Terminate workers, destroy pdf.js pages, revoke object URLs.
- Code must compile (tsc --noEmit) and tests must pass before you finish a phase.

## Working protocol
At the end of each phase output: (1) file tree of what changed, (2) how to run and verify, (3) acceptance checklist with pass/fail, (4) known limitations, (5) what Phase N+1 will build on, (6)push to github repository if done. Then STOP and wait.
