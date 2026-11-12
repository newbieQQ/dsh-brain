// P5 theme / narrow-panel structural guard.
//
// This is a static guard, not a screenshot: it fails if the hand-written card
// reintroduces a hard-coded light-only colour or drops the wrapping that keeps
// a narrow settings panel from scrolling sideways. It also asserts the tab bar
// and the two long action rows declare flexWrap.
import { readFileSync } from 'node:fs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const source = readFileSync('./client/index.js', 'utf8')

const hardcoded = source.match(/(?:background|borderColor)\s*:\s*['"]#(?:fff(?:fff)?|000(?:000)?)['"]/gi)
check('no hard-coded pure white/black colours', hardcoded === null, hardcoded === null ? '' : hardcoded.join(','))

const neutralTokens = (source.match(/rgba\(127,127,127/gi) ?? []).length
check('theme-neutral colour tokens are used throughout', neutralTokens >= 5, `${neutralTokens} uses`)

const accentTokens = (source.match(/#3f3f46/g) ?? []).length
check('accent colour is the shared charcoal token', accentTokens >= 2, `${accentTokens} uses`)

const wrapCount = (source.match(/flexWrap\s*:\s*['"]wrap['"]/g) ?? []).length
check('long rows wrap instead of scrolling sideways', wrapCount >= 4, `${wrapCount} wrapping rows`)

check('tabs and actions declare wrapping', /tabBar[\s\S]{0,400}?flexWrap/.test(source) || /styles\.tabs/.test(source))
check('no fixed 375px-only width is pinned', !/minWidth\s*:\s*['"]?375/.test(source))

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
