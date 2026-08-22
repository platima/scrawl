/*
 * Builds single file versions of the two demo pages, with scrawl.js and
 * scrawl.css inlined. Handy for pasting into a CodePen, emailing to someone,
 * or previewing anywhere that will not resolve sibling files.
 *
 *   node build.js
 *
 * Outputs index.standalone.html and css-only.standalone.html.
 */
const fs = require('fs');
const path = require('path');

const here = __dirname;
const read = f => fs.readFileSync(path.join(here, f), 'utf8');

const js = read('scrawl.js');
const css = read('scrawl.css');

// index.html: swap the external script for the source itself
let index = read('index.html')
  .replace('<script src="scrawl.js"></script>', '<script>\n' + js + '\n</script>')
  .replace('href="css-only.html"', 'href="css-only.standalone.html"');

// css-only.html: swap the stylesheet link for a style block
let cssOnly = read('css-only.html')
  .replace('<link rel="stylesheet" href="scrawl.css">', '<style>\n' + css + '\n</style>')
  .replace('href="index.html"', 'href="index.standalone.html"');

const banner = '<!-- Built by build.js. Edit index.html / css-only.html, not this file. -->\n';

fs.writeFileSync(path.join(here, 'index.standalone.html'), banner + index);
fs.writeFileSync(path.join(here, 'css-only.standalone.html'), banner + cssOnly);

const kb = f => (fs.statSync(path.join(here, f)).size / 1024).toFixed(1) + ' KB';
console.log('index.standalone.html   ', kb('index.standalone.html'));
console.log('css-only.standalone.html', kb('css-only.standalone.html'));
