## Pretext

Internal notes for contributors and agents. Use `README.md` as the public source of truth for API examples and user-facing limitations. Use `STATUS.md` for the compact current browser-accuracy / benchmark dashboard, `accuracy/chrome.json` / `accuracy/safari.json` / `accuracy/firefox.json` for the checked-in raw browser accuracy rows, `benchmarks/chrome.json` and `benchmarks/safari.json` for the checked-in current benchmark snapshots, `corpora/STATUS.md` for the compact corpus snapshot, `corpora/representative.json` for the current machine-readable representative corpus rows, `corpora/TAXONOMY.md` for the shared mismatch vocabulary, `RESEARCH.md` for the detailed exploration log, and `TODO.md` for the current priorities.

### Commands

- `bun start` — serve pages at http://localhost:3000 with full code reload (kills stale `:3000` listeners first)
- `bun run check` — typecheck + lint
- `bun test` — lightweight invariant tests against the shipped implementation
- `bun run accuracy-check` / `:safari` / `:firefox` — browser accuracy sweeps
- `bun run accuracy-snapshot` / `:safari` / `:firefox` — full raw browser accuracy rows written to `accuracy/*.json`
- `bun run benchmark-check` / `:safari` — benchmark snapshot with both the short shared corpus and long-form corpus stress rows, including `prepare()` phase split (`analyze` vs `measure`) for the long-form corpora
- `bun run corpus-check --id=... --font='20px ...' --lineHeight=32` — corpus spot check with optional font override
- `bun run corpus-representative` — refresh the checked-in representative corpus anchor rows in `corpora/representative.json`
- `bun run corpus-sweep --id=... --samples=9 --font='20px ...'` — sampled width sweep; use this before a dense sweep on large corpora
- `bun run corpus-font-matrix --id=... --samples=5` — sampled cross-font check for one checked-in corpus
- `bun run corpus-taxonomy --id=... 300 450 600` — classify current mismatches by rough steering bucket (`edge-fit`, `glue-policy`, `boundary-discovery`, `shaping-context`, etc.) using the full browser diagnostics
- `bun run gatsby-check` / `:safari` — Gatsby canary diagnostics
- `bun run gatsby-sweep --start=300 --end=900 --step=10` — fast Gatsby width sweep; add `--diagnose` to rerun mismatching widths through the slow checker
- `bun run probe-check --text='...' --width=320 --font='20px ...' --dir=rtl --lang=ar --method=range|span` — isolate a single snippet in the real browser and choose the browser-line extraction method explicitly
- `bun run corpus-check --id=mixed-app-text --diagnose --method=span|range 710` — compare corpus-line extraction methods directly when a mismatch may be diagnostic-tool sensitive

### Important files

- `src/layout.ts` — core library; keep `layout()` fast and allocation-light
- `src/analysis.ts` — normalization, segmentation, glue rules, and text-analysis phase for `prepare()`
- `src/measurement.ts` — canvas measurement runtime, segment metrics cache, emoji correction, and engine-profile shims
- `src/line-break.ts` — internal line-walking core shared by the rich layout APIs and the hot-path line counter
- `src/bidi.ts` — simplified bidi metadata helper for the rich `prepareWithSegments()` path
- `src/measure-harfbuzz.ts` — HarfBuzz backend kept for ad hoc measurement probes
- `src/test-data.ts` — shared corpus for browser accuracy pages/checkers and benchmarks
- `src/layout.test.ts` — small durable invariant tests for the exported prepare/layout APIs
- `pages/accuracy.ts` — browser sweep plus per-line diagnostics
- `accuracy/chrome.json` / `accuracy/safari.json` / `accuracy/firefox.json` — checked-in raw accuracy rows backing `STATUS.md`
- `pages/benchmark.ts` — performance comparisons
- `benchmarks/chrome.json` / `benchmarks/safari.json` — checked-in current benchmark snapshots backing `STATUS.md`
- `corpora/representative.json` — checked-in representative corpus anchor rows backing `corpora/STATUS.md`
- `pages/diagnostic-utils.ts` — shared grapheme-safe diagnostic helpers used by the browser check pages
- `pages/demos/bubbles.ts` — bubble shrinkwrap demo using the rich non-materializing line-range walker
- `pages/demos/dynamic-layout.ts` — fixed-height editorial spread with a continuous two-column flow, obstacle-aware title routing, and live logo-driven reflow

### Implementation notes

- `prepare()` / `prepareWithSegments()` do horizontal-only work. `layout()` / `layoutWithLines()` take explicit `lineHeight`.
- `setLocale(locale?)` retargets the hoisted word segmenter for future `prepare()` calls and clears shared caches. Use it before preparing new text when the app wants a specific `Intl.Segmenter` locale instead of the runtime default.
- `prepare()` should stay the opaque fast-path handle. If a page/script needs segment arrays, that should usually flow through `prepareWithSegments()` instead of re-exposing internals on the main prepared type.
- `walkLineRanges()` is the rich-path batch geometry API: no string materialization, but still browser-like line widths/cursors/discretionary-hyphen state. Prefer it over private line walkers for shrinkwrap or aggregate layout work.
- `prepare()` is internally split into a text-analysis phase and a measurement phase; keep that seam clear, but keep the public API simple unless requirements force a change.
- The internal segment model now distinguishes at least five break kinds: normal text, collapsible spaces, non-breaking glue (`NBSP` / `NNBSP` / `WJ`-like runs), zero-width break opportunities, and soft hyphens. Do not collapse those back into one boolean unless the model gets richer in a better way.
- `layout()` is the resize hot path: no DOM reads, no canvas calls, no string work, and avoid gratuitous allocations.
- Segment metrics cache is `Map<font, Map<segment, metrics>>`; shared across texts and resettable via `clearCache()`. Width is only one cached fact now; grapheme widths and other segment-derived facts can be populated lazily.
- Word and grapheme segmenters are hoisted at module scope. Any locale reset should also clear the word cache.
- Punctuation is merged into preceding word-like segments only, never into spaces.
- Arabic no-space punctuation clusters such as `فيقول:وعليك` and `همزةٌ،ما` are merged during `prepare()`; keep that logic in preprocessing, not `layout()`.
- That Arabic no-space merge set is intentionally narrow right now: colon / period / Arabic comma / Arabic semicolon. Repeated `!` was a counterexample that over-merged.
- If `Intl.Segmenter` emits an Arabic punctuation cluster with trailing combining marks (for example `،ٍ`), still treat the whole cluster as left-sticky punctuation during preprocessing. The browser keeps `بكشء،ٍ` together.
- If `Intl.Segmenter` emits `" " + combining marks` before Arabic text (for example `كل ِّواحدةٍ`), split it into `" "` plus marks-prefix-on-next-word during preprocessing.
- `NBSP`-style glue should survive `prepare()` as visible content and prevent ordinary word-boundary wrapping; `ZWSP` should survive as a zero-width break opportunity.
- Soft hyphens should stay invisible when unbroken, but if the engine chooses that break, the broken line should expose a visible trailing hyphen in `layoutWithLines()`.
- If a soft hyphen wins the break, the rich line APIs should still expose the visible trailing `-` in `line.text`, even though the public line types do not currently carry a separate soft-hyphen metadata flag.
- `layoutNextLine()` is the rich-path escape hatch for variable-width userland layout. It now hides its grapheme-cache bookkeeping again by internally splitting line stepping from text materialization. Keep that internal split semantically aligned with `layoutWithLines()`, but do not pull its extra bookkeeping into the hot `layout()` path.
- Astral CJK ideographs, compatibility ideographs, and the later extension blocks must still hit the CJK path; do not rely on BMP-only `charCodeAt()` checks there.
- Non-word, non-space segments are break opportunities, same as words.
- CJK grapheme splitting plus kinsoku merging keeps prohibited punctuation attached to adjacent graphemes.
- Emoji correction is auto-detected per font size, constant per emoji grapheme, and effectively font-independent.
- Bidi levels now stay on the rich `prepareWithSegments()` path as custom-rendering metadata only. The opaque fast `prepare()` handle should not pay for bidi metadata that `layout()` does not consume, and line breaking itself does not read those levels.
- A larger pure-TS Unicode stack like `text-shaper` is useful as reference material, especially for Unicode coverage and richer bidi metadata, but its runtime segmentation and greedy glyph-line breaker are not replacements for our browser-facing `Intl.Segmenter` + preprocessing + canvas-measurement model.
- Supported CSS target is the common app-text configuration: `white-space: normal`, `word-break: normal`, `overflow-wrap: break-word`, `line-break: auto`.
- That default target means narrow widths may still break inside words, but only at grapheme boundaries. Keep the core engine honest to that behavior; if an editorial page wants stricter whole-word handling, layer it on top in userland instead of quietly changing the library default.
- `system-ui` is unsafe for accuracy; canvas and DOM can resolve different fonts on macOS.
- Thai historically mismatched because CSS and `Intl.Segmenter` use different internal dictionaries; keep it in the browser sweep when changing segmentation rules.
- HarfBuzz probes need explicit LTR to avoid wrong direction on isolated Arabic words.
- Accuracy pages and checkers are now expected to be green in all three installed browsers on fresh runs; if a page disagrees, suspect stale tabs/servers before changing the algorithm.
- The browser automation lock is self-healing for stale dead-owner files now, but it is still single-owner per browser. If a checker times out on the lock, confirm a live checker process still owns it before changing the algorithm.
- Accuracy/corpus/Gatsby checkers can use background-safe browser automation, but benchmark runs should stay foreground. Do not “optimize away” benchmark focus; throttled/background tabs make the numbers less trustworthy.
- For deep perf or memory work, prefer an isolated debuggable Chrome over a pure Bun microbenchmark. Bun is fine for quick hypotheses, but Chrome profiling is the better source of truth for CPU hotspots, allocation churn, and retained-heap checks.
- Refresh `benchmarks/chrome.json` and `benchmarks/safari.json` when a diff changes benchmark methodology or the text engine hot path (`src/analysis.ts`, `src/measurement.ts`, `src/line-break.ts`, `src/layout.ts`, `src/bidi.ts`, or `pages/benchmark.ts`). `STATUS.md` should stay a compact dashboard, not the only source of current benchmark numbers.
- `bun start` is the live human-facing dev server and now runs with `--watch` (full code reload). The scripted checkers intentionally keep using `--no-hmr` temporary servers so their runs stay deterministic and easy to tear down.
- Do not run multiple browser corpus/sweep/font-matrix jobs in parallel against the same browser. The automation session and temporary page server paths interfere with each other and can make a healthy corpus look hung or flaky.
- An `ERR_CONNECTION_REFUSED` tab on `localhost:3210` or a similar temporary checker port usually means you caught a per-run Bun server after teardown. That is expected after the script exits; it is not, by itself, evidence of a bad measurement.
- Keep `src/layout.test.ts` small and durable. For browser-specific or narrow hypothesis work, prefer throwaway probes/scripts and promote only the stable invariants into permanent tests.
- For Gatsby canary work, sweep widths cheaply first and only diagnose the mismatching widths in detail. The slow detailed checker is for narrowing root causes, not for every width by default.
- For Arabic corpus work, trust the RTL `Range`-based diagnostics over the old span-probe path. The remaining misses are currently more about break policy than raw width sums.
- For Arabic probe work, always use normalized corpus slices and the exact corpus font. Raw file offsets or a rough fallback font will mislead you.
- The corpus/probe diagnostic pages now compute our line offsets directly from prepared segments and grapheme fallbacks; do not go back to reconstructing them from `layoutWithLines().line.text.length`.
- The Arabic corpus text has already been cleaned for quote-before-punctuation spacing artifacts like `" ،`, `" .`, and `" ؟`, plus a few obvious `space + punctuation` typos (`هيهات !`, `دجاك ؟!`, `القيان :`). Treat those as corpus hygiene, not engine behavior.
- The repeated Arabic fine-width miss around `قوله:"...` was also a source-text issue; normalizing that one occurrence to `قوله: “...` removed several widths without touching the engine.
- Thai prose can expose ASCII quote behavior like `ทูลว่า "พระองค์...`; treating `"` as contextual quote glue in preprocessing helps there without needing a Thai-specific rule.
- Khmer anthology (`ប្រជុំរឿងព្រេងខ្មែរ/ភាគទី៧`, stories 1-10) is now a checked-in Southeast Asian stress canary. Keep the explicit zero-width separators from source cleanup; flattening them would destroy the useful break-opportunity signal.
- A Lao raw-law corpus was tried and rejected. The source text was stored as wrapped print lines, which made it a dirty `white-space: normal` canary. Do not resurrect that path unless the acquisition method changes.
- Myanmar prose (`စဉ်းလဲသော ဗျိုင်း (ဆရာ)`) is now a clean checked-in Southeast Asian canary, and the current sampled sweep is exact in Chrome.
- The Myanmar keeps are still semantic, not script-specific engine overreach: `၊` / `။` / `၍` / `၌` / `၏` stay attached during preprocessing, and `၏` also acts as medial glue so clusters like `ကျွန်ုပ်၏လက်မ` do not break in the middle.
- Do not assume the sampled Myanmar sweep means the script is solved. The fuller `step=10` field is still imperfect, and two tempting follow-ups were both rejected: broad Myanmar grapheme breaks in normal wrapping, and closing-quote + `ဟု` glue. Both helped Chrome and hurt Safari.
- A second clean Myanmar corpus (`မကောင်းမှုဒဏ် ကိုယ့်ထံပြန် (ဆရာ)`) is now checked in. It is exact at the anchor widths, healthier overall than the first Myanmar text, but it still shows the same broad closing-quote + `ဟု` class in Chrome while Safari disagrees locally. Treat that class as diagnostic signal, not a safe shared-engine heuristic.
- Urdu prose (`چغد`) is now a checked-in RTL canary under a Nastaliq/Naskh-style font stack. It is exact at `600 / 800`, but both Chrome and Safari miss the narrow `300px` anchor by two lines and the broader Chrome field stays negative. Treat that as a real shaping/context canary, not corpus dirt.
- `/corpus`, `corpus-check`, and `corpus-sweep` now accept `font` / `lineHeight` overrides. Use those before inventing a second page or checker when the question is “does this same corpus stay healthy under another font?”
- The sampled Chrome font matrix stayed exact across the current Korean/Thai/Khmer/Hindi/Arabic/Hebrew corpora. Safari font-matrix automation is slower and noisier, so Chrome is the better first pass and Safari should be treated as follow-up smoke coverage.
- Mixed app text is now a first-class canary. Use it to catch product-shaped classes like URL/query-string wrapping, emoji ZWJ runs, and mixed-script punctuation before tuning another book corpus.
- URL-like runs such as `https://...` / `www...` are currently modeled as two breakable preprocessing units when a query exists: the path through the query introducer (`?`), then the query string. This is intentionally narrow and exists to stop obviously bad mid-path URL breaks without forcing the whole query string to fragment character-by-character.
- Mixed app text also pulled in two more keep-worthy preprocessing rules: contextual escaped quote clusters like `\"word\"`, and numeric/time-range runs like `२४×७` / `7:00-9:00`.
- For Southeast Asian scripts or mixed text containing Thai/Lao/Khmer/Myanmar, trust the `Range`-based corpus diagnostics over span-probing; span units can perturb line breaking there.
- That rule now has one explicit caveat: the remaining Chrome mixed-app `710px` soft-hyphen miss is extractor-sensitive **and** not cleanly local. Both extractors agree the full-corpus miss is real, but isolated paragraph/slice probes go exact in height. Safari is exact there again in height/line count, though local manual line-content drift still exists. Treat the remaining Chrome width as paragraph-scale / accumulation-sensitive until a cleaner reproducer appears, and do not patch the engine from only one extractor view.
- Safari `Range`-based probe extraction can over-advance across URL query text (`...path?q`) even when the real DOM height and the `span` extractor are exact. Cross-check `--method=span` before changing the engine on Safari URL/query probe misses.
- A second Thai prose corpus (`นิทานเวตาล เรื่องที่ ๗`) is now checked in and exact at Chrome/Safari anchor widths plus a 9-sample Chrome sweep. Treat current Thai support as broader than one lucky story, but still verify new Thai text before declaring the whole script “done.”
- Khmer anchor widths were exact in both Chrome and Safari, and a 9-sample Chrome sweep was exact. The full `step=10` sweep was slow enough to be annoying, so use `--samples=<n>` first unless you specifically need every width.
- Japanese `羅生門` is now a checked-in canary. The first keep-worthy Japanese rule was semantic, not font-specific: kana iteration marks like `ゝ` / `ゞ` / `ヽ` / `ヾ` should be treated as CJK line-start-prohibited, even when `Intl.Segmenter` emits them as standalone word-like pieces.
- A second Japanese prose corpus (`蜘蛛の糸`) is now checked in. It is exact at Chrome/Safari anchor widths, `8/9 exact` on the sampled Chrome sweep, and `56/61 exact` on Chrome `step=10`. Treat the recurring one-line positive field as a real Japanese edge-fit class, not source dirt.
- If a CJK opening punctuation mark like `「` or `（` lands at the end of a larger CJK segment, carry that trailing opening-punctuation cluster forward onto the next CJK segment during preprocessing. Otherwise the browser can keep the punctuation with the next ideograph while our model leaves it stranded at line end.
- Chinese prose (`祝福`) is now a checked-in long-form canary. It is exact at the Safari anchors and at Chrome `600 / 800`, but Chrome keeps a broader positive one-line field at narrow widths, with `PingFang SC` widening that field relative to `Songti SC`.
- A second Chinese prose canary (`故鄉`) is now checked in. It keeps the same broad class: exact Safari anchors, exact Chrome `600 / 800`, and a narrower but still real positive field in Chrome, with a different `Songti SC` vs `PingFang SC` split.
- Two tempting Chinese follow-ups were tried and rejected: carrying stranded closing quotes like `」` / `』` forward onto the next CJK segment, and coalescing standalone `——` / `……` runs. Both made `祝福` worse on the broader Chrome sweep. Treat the remaining Chinese field as a real canary, not an obviously missing preprocessing rule.
- The corpus diagnostics should derive our candidate lines from `layoutWithLines()`, not from a second local line-walker. That avoids SHY and future custom-break drift between the hot path and the diagnostic path.
- Current line-fit tolerance is `0.005` for Chromium/Gecko and `1/64` for Safari/WebKit. That bump was justified by the remaining Arabic fine-width field and did not move the solved browser corpus or Gatsby coarse canary.
- Refresh `accuracy/chrome.json`, `accuracy/safari.json`, and `accuracy/firefox.json` when a diff changes the browser sweep methodology or the main text engine behavior (`src/analysis.ts`, `src/measurement.ts`, `src/line-break.ts`, `src/layout.ts`, `src/bidi.ts`, or `pages/accuracy.ts`).
- Refresh `corpora/representative.json` when a diff intentionally changes one of the tracked representative canaries or their canonical anchor behavior. Keep it compact: anchors and designated fragile-width sentinels, not every exploratory sweep result.

### Open questions

- Decide whether line-fit tolerance should stay as a browser-specific shim or move to runtime calibration alongside emoji correction.
- If a future Arabic corpus still exposes misses after preprocessing and corpus cleanup, decide whether that needs a richer break-policy model or a truly shaping-aware architecture beyond segment-sum layout.
- `layoutWithLines()` now returns line boundary cursors (`start` / `end`) in addition to `{ text, width }`; keep that data model useful for future manual reflow work, especially for the richer editorial demos.
- The dynamic-layout demo is the current real consumer of the rich line API. If a future custom-layout page wants more metadata, make it prove that need there before expanding the rich API again.
- The browser demos should increasingly dogfood `layoutNextLine()` rather than depending on `layoutWithLines()` for whole-paragraph materialization. That keeps the streaming userland path honest.
- ASCII fast path could skip some CJK, bidi, and emoji overhead.
- Benchmark methodology still needs review.
- Additional CSS configs are still untested: `break-all`, `keep-all`, `strict`, `loose`, `anywhere`, `pre-wrap`.

### Related

- `../text-layout/` — Sebastian Markbage's original prototype + our experimental variants.
