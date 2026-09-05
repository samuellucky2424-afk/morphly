import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const source = (file) => readFile(new URL(file, import.meta.url), 'utf8');

test('all pages use semantic light surfaces rather than hard-coded dark panels', async () => {
  for (const file of await readdir(new URL('../src/pages/', import.meta.url))) {
    if (!file.endsWith('.tsx')) continue;
    const code = await source(`../src/pages/${file}`);
    assert.doesNotMatch(code, /\bbg-(?:black|zinc-(?:800|900|950))\b|\bbg-\[#[0-3][0-9a-f]{5}\]/i, file);
  }
  const voice = await source('../src/components/MeanVcPanel.tsx');
  assert.match(voice, /bg-background text-foreground/);
  assert.match(voice, /disabled:bg-muted disabled:text-muted-foreground/);
});

test('approved red actions have accessible white text and the desktop does not follow OS dark mode', async () => {
  const css = await source('../src/styles/theme.css');
  assert.match(css, /color-scheme: light/);
  assert.match(css, /--background: 0 0% 100%/);
  assert.match(css, /--primary: 353\.4146 69\.4915% 46\.2745%/);
  const rgb = [200,36,54].map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  assert.ok(1.05 / (.2126*rgb[0] + .7152*rgb[1] + .0722*rgb[2] + .05) >= 4.5);
  const electron = await source('../electron/main.js');
  assert.match(electron, /nativeTheme.themeSource = 'light'/);
  assert.doesNotMatch(electron, /backgroundColor: '#000000'|color-scheme: dark/);
  assert.match(await source('../src/components/ui/sonner.tsx'), /theme="light"/);
  assert.match(await source('../src/components/ui/tooltip.tsx'), /bg-popover text-popover-foreground/);
});

test('private admin portal and feedback dialogs share the approved action theme', async () => {
  assert.match(await source('../../morphly-admin-dashboard/styles.css'), /--nav: #ffffff/);
  assert.match(await source('../vite.config.ts'), /src\/styles\/theme\.css/);
  for (const file of ['customer-engagement.css','admin-engagement.css']) {
    const css = await source(`../src/components/${file}`);
    assert.match(css, /background:hsl\(var\(--primary\)\)/);
    assert.doesNotMatch(css, /background:#(?:10141b|17202e)/);
  }
});
