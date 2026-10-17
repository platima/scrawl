/*
 * Builds everything that is generated rather than written:
 *
 *   scrawl.min.js             minified library, the file CDN links point at
 *   index.standalone.html     JS demo with scrawl.js and scrawl-note.css inlined
 *   css-only.standalone.html  CSS demo with scrawl.css and scrawl-note.css inlined
 *
 *   node build.js
 *
 * The standalone pages are handy for pasting into a CodePen, emailing to
 * someone, or previewing anywhere that will not resolve sibling files.
 *
 * Minifying shells out to terser, pinned, through npx. There is nothing to
 * install first and the repo keeps no dependencies of its own. If terser
 * cannot be fetched the build says so and leaves the committed scrawl.min.js
 * alone rather than shipping a stale file that looks fresh.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const zlib = require('zlib');

const TERSER = 'terser@5.36.0';

const here = __dirname;
const at = f => path.join(here, f);
const read = f => fs.readFileSync(at(f), 'utf8');

/* A silent no-op here would emit a "standalone" file that still points at its
   siblings, print a size and exit 0, so every swap has to be checked. Splitting
   rather than replacing also catches every occurrence: the sibling links appear
   in both the hero and the footer, and replace() with a string needle takes
   only the first. */
function swap(src, from, to, where) {
  const parts = src.split(from);
  if (parts.length < 2) {
    throw new Error('build.js: could not find ' + JSON.stringify(from) + ' in ' + where +
                    '.\nThe demo markup changed. Update build.js to match.');
  }
  return parts.join(to);
}

/* ------------------------------------------------------------------ min */

function minify() {
  const out = at('scrawl.min.js');
  /* npx is a .cmd on Windows, which recent Node refuses to spawn without a
     shell. Passing one quoted command string rather than an argv array keeps
     the shell from re-splitting paths that contain spaces. */
  const q = p => '"' + p + '"';
  const cmd = ['npx', '--yes', TERSER, q(at('scrawl.js')), '-c', '-m', '-o', q(out)].join(' ');
  const res = spawnSync(cmd, { encoding: 'utf8', shell: true });
  if (res.status !== 0) {
    console.warn('! scrawl.min.js NOT rebuilt: could not run ' + TERSER + '.');
    if (res.stderr) console.warn('  ' + res.stderr.trim().split('\n').slice(-2).join('\n  '));
    console.warn('  The committed copy is now older than scrawl.js. Rerun with a network');
    console.warn('  connection before tagging a release.');
    return false;
  }
  /* terser keeps the /*! banner by default, and that banner carries the MIT
     notice every CDN user receives. Losing it is a licensing problem, not a
     cosmetic one, so fail loudly rather than committing a stripped file. */
  if (read('scrawl.min.js').indexOf('MIT licence') < 0) {
    throw new Error('build.js: the licence banner is missing from scrawl.min.js.');
  }
  return true;
}

const rebuilt = minify();

/* ---------------------------------------------------------- standalone */

const js = read('scrawl.js');
const css = read('scrawl.css');
const noteLink = '<link rel="stylesheet" href="scrawl-note.css">';
const noteStyle = '<style>\n' + read('scrawl-note.css') + '\n</style>';

let index = read('index.html');
index = swap(index, '<script src="scrawl.js"></script>', '<script>\n' + js + '\n</script>', 'index.html');
index = swap(index, noteLink, noteStyle, 'index.html');
index = swap(index, 'href="css-only.html"', 'href="css-only.standalone.html"', 'index.html');

let cssOnly = read('css-only.html');
cssOnly = swap(cssOnly, '<link rel="stylesheet" href="scrawl.css">', '<style>\n' + css + '\n</style>', 'css-only.html');
cssOnly = swap(cssOnly, noteLink, noteStyle, 'css-only.html');
/* No closing quote, so a link to a section of the page, #arrows, swaps too. */
cssOnly = swap(cssOnly, 'href="index.html', 'href="index.standalone.html', 'css-only.html');

const banner = '<!-- Built by build.js. Edit index.html / css-only.html, not this file. -->\n';

fs.writeFileSync(at('index.standalone.html'), banner + index);
fs.writeFileSync(at('css-only.standalone.html'), banner + cssOnly);

/* --------------------------------------------------------------- sizes */

const kb = b => (b / 1024).toFixed(1) + ' KB';
function report(f) {
  const bytes = fs.readFileSync(at(f));
  const gz = zlib.gzipSync(bytes, { level: 9 }).length;
  console.log(f.padEnd(25) + kb(bytes.length).padStart(9) + '   ' + kb(gz).padStart(9) + ' gzipped');
}

console.log('');
if (rebuilt) report('scrawl.min.js');
report('scrawl.css');
report('scrawl-note.css');
report('index.standalone.html');
report('css-only.standalone.html');
console.log('\nThe two figures for scrawl.min.js are the ones quoted in README.md and');
console.log('in the demo page header. Update both if they have moved.');
