import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFile(join(root, path), 'utf8');

const tagAttributes = (markup, name) => {
  const tag = markup.match(new RegExp(`<${name}\\b[^>]*>`, 'i'))?.[0];
  assert.ok(tag, `Missing <${name}>`);
  return Object.fromEntries(
    [...tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map(([, key, value]) => [key, value])
  );
};

const numbers = value => value.trim().split(/[\s,]+/).map(Number);
const compactPath = value => value.replace(/[\s,]+/g, '');
const pathTokens = value =>
  (value.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [])
    .map(token => /^[A-Za-z]$/.test(token) ? token : Number(token));

const smallAnchorGeometry = (markup, rootTag) => {
  const rootAttrs = tagAttributes(markup, rootTag);
  const circle = tagAttributes(markup, 'circle');
  const path = tagAttributes(markup, 'path');
  return {
    viewBox: numbers(rootAttrs.viewBox),
    circle: [circle.cx, circle.cy, circle.r].map(Number),
    circleStroke: [circle.stroke, Number(circle['stroke-width']), circle.fill],
    path: compactPath(path.d),
    pathStroke: [path.stroke, Number(path['stroke-width']), path.fill, path['stroke-linecap']]
  };
};

test('manifest, package, and README versions agree', async () => {
  const [manifest, pkg, readme] = await Promise.all([
    read('manifest.json').then(JSON.parse),
    read('package.json').then(JSON.parse),
    read('README.md')
  ]);
  assert.equal(manifest.version, '0.8.1');
  assert.equal(pkg.version, manifest.version);
  assert.match(readme, new RegExp(`Current version: \\*\\*${manifest.version.replaceAll('.', '\\.')}\\*\\*\\.`));
  assert.deepEqual(manifest.permissions, [
    'tabs', 'storage', 'alarms', 'favicon', 'sidePanel', 'browsingData', 'cookies'
  ]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
});

test('manifest icons exist as correctly sized PNGs', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  const expected = Object.fromEntries(
    [16, 32, 48, 128].map(size => [String(size), `icons/icon${size}.png`])
  );
  assert.deepEqual(manifest.icons, expected);
  assert.deepEqual(manifest.action?.default_icon, expected);

  for (const [size, path] of Object.entries(expected)) {
    const png = await readFile(join(root, path));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} signature`);
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR', `${path} IHDR`);
    assert.equal(png.readUInt32BE(16), Number(size), `${path} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${path} height`);
  }
});

test('the optical SVG uses the panel i-anchor geometry', async () => {
  const [svg16, html] = await Promise.all([read('icons/anchors-16.svg'), read('panel.html')]);
  const symbol = html.match(/<symbol\b[^>]*\bid="i-anchor"[^>]*>[\s\S]*?<\/symbol>/i)?.[0];
  assert.ok(symbol, 'Missing #i-anchor symbol');
  assert.deepEqual(smallAnchorGeometry(svg16, 'svg'), smallAnchorGeometry(symbol, 'symbol'));
});

test('master and monochrome SVGs share anchor glyph geometry', async () => {
  const [master, mono] = await Promise.all([read('icons/anchors.svg'), read('icons/anchors-mono.svg')]);
  const masterRoot = tagAttributes(master, 'svg');
  const monoRoot = tagAttributes(mono, 'svg');
  const masterGroup = tagAttributes(master, 'g');
  const monoGroup = tagAttributes(mono, 'g');

  const glyphGeometry = markup => {
    const circle = tagAttributes(markup, 'circle');
    const path = tagAttributes(markup, 'path');
    return {
      circle: [circle.cx, circle.cy, circle.r].map(Number),
      path: pathTokens(path.d)
    };
  };

  assert.deepEqual(numbers(masterRoot.viewBox), [0, 0, 128, 128]);
  assert.deepEqual(numbers(monoRoot.viewBox), numbers(masterRoot.viewBox));
  assert.deepEqual(glyphGeometry(mono), glyphGeometry(master));
  assert.deepEqual(
    [monoGroup.fill, monoGroup['stroke-width'], monoGroup['stroke-linecap'], monoGroup['stroke-linejoin']],
    [masterGroup.fill, masterGroup['stroke-width'], masterGroup['stroke-linecap'], masterGroup['stroke-linejoin']]
  );
  assert.equal(masterGroup.stroke, '#7c9cff');
  assert.equal(monoGroup.stroke, 'currentColor');
  assert.equal((master.match(/<rect\b/gi) || []).length, 1, 'master has one background badge');
  assert.equal((mono.match(/<rect\b/gi) || []).length, 0, 'mono glyph has no badge or tab rectangle');
});

test('every static UI and manifest localization key exists', async () => {
  const [html, panelJs, manifestText, messages] = await Promise.all([
    read('panel.html'),
    read('panel.js'),
    read('manifest.json'),
    read('_locales/en/messages.json').then(JSON.parse)
  ]);
  const keys = new Set();
  for (const match of html.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)) keys.add(match[1]);
  for (const match of panelJs.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) keys.add(match[1]);
  for (const match of manifestText.matchAll(/__MSG_([^_]+)__/g)) keys.add(match[1]);
  const missing = [...keys].filter(key => !(key in messages));
  assert.deepEqual(missing, []);
});

test('panel selectors and SVG references resolve', async () => {
  const [html, panelJs] = await Promise.all([read('panel.html'), read('panel.js')]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const selectorIds = [...panelJs.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)/g)].map(match => match[1]);
  const svgRefs = [...html.matchAll(/<use\s+href="#([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(selectorIds.filter(id => !ids.has(id)))], []);
  assert.deepEqual([...new Set(svgRefs.filter(id => !ids.has(id)))], []);
});

test('text sources contain no Cyrillic copy', async () => {
  const extensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs']);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'dist' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (extensions.has(extname(entry.name))) files.push(path);
    }
  }
  await walk(root);
  const offenders = [];
  for (const file of files) {
    if (/[\u0400-\u04ff]/.test(await readFile(file, 'utf8'))) offenders.push(file.slice(root.length + 1));
  }
  assert.deepEqual(offenders, []);
});
