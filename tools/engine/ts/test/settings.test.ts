import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { loadSettings, DEFAULT_SETTINGS, writeSettingKey, ensureSettingsFile } from '../src/settings.ts';

function projectWith(settings: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'yo-settings-'));
  if (settings != null) {
    mkdirSync(join(root, '.yamlover'), { recursive: true });
    writeFileSync(join(root, '.yamlover', 'settings.yamlover'), settings);
  }
  return root;
}

test('no settings file → defaults', () => {
  const root = projectWith(null);
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
  rmSync(root, { recursive: true, force: true });
});

test('annotations is read and normalized (a plain-string path, leading/trailing : stripped)', () => {
  const root = projectWith('annotations: notes/marks/\n');
  assert.equal(loadSettings(root).annotations, ':notes:marks');
  rmSync(root, { recursive: true, force: true });
});

test('unsafe or empty locations fall back to the default', () => {
  for (const bad of ['annotations: ../outside\n', 'annotations: "/"\n', 'annotations: ""\n']) {
    const root = projectWith(bad);
    assert.equal(loadSettings(root).annotations, DEFAULT_SETTINGS.annotations);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unparsable settings file yields the defaults (never breaks serving)', () => {
  const root = projectWith(':: not yamlover {{{');
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
  rmSync(root, { recursive: true, force: true });
});

test('a PROJECT-scope *-pointer is the canonical location form (*:: name → :name)', () => {
  const root = projectWith('tags: *:: taxonomy: places\n');
  assert.equal(loadSettings(root).tags, ':taxonomy:places');
  rmSync(root, { recursive: true, force: true });
});

test('document/current scope pointers are accepted leniently too (resolved against the served root)', () => {
  const root = projectWith('annotations: *: notes\ntags: *:: tags\n');
  const s = loadSettings(root);
  assert.equal(s.annotations, ':notes'); // *: → document root
  assert.equal(s.tags, ':tags'); // *:: → project root
  rmSync(root, { recursive: true, force: true });
});

test('annotation-tag persists the last-used tag as a *::/*::: pointer (→ a project path); absent → undefined', () => {
  assert.equal(loadSettings(projectWith(null)).annotationTag, undefined);
  const root = projectWith('annotation-tag: *:: yamlover: tags: colors: yellow\n');
  assert.equal(loadSettings(root).annotationTag, ':yamlover:tags:colors:yellow');
  rmSync(root, { recursive: true, force: true });
});

test('pointers that cannot name a place inside the root fall back to the default', () => {
  for (const bad of ['tags: *.. : outside\n', 'tags: *:: ..: outside\n']) {
    const root = projectWith(bad);
    assert.equal(loadSettings(root).tags, DEFAULT_SETTINGS.tags, bad);
    rmSync(root, { recursive: true, force: true });
  }
});

test('one odd field does not sink the others', () => {
  const root = projectWith('annotations: marks\ntags: 7\n');
  const s = loadSettings(root);
  assert.equal(s.annotations, ':marks');
  assert.equal(s.tags, DEFAULT_SETTINGS.tags);
  rmSync(root, { recursive: true, force: true });
});

test('uri + exports: parsed from the config (IMPORTS.md §1/§2); absent → undefined / []', () => {
  assert.equal(loadSettings(projectWith(null)).uri, undefined);
  assert.deepEqual(loadSettings(projectWith(null)).exports, []);
  // authored as a bare `::: host` scalar
  assert.equal(loadSettings(projectWith('uri: "::: yamlover.inthemoon.net"\n')).uri, 'yamlover.inthemoon.net');
  // or as a world pointer
  assert.equal(loadSettings(projectWith('uri: *::: yamlover.inthemoon.net\n')).uri, 'yamlover.inthemoon.net');
  // exports: a list of pointer/query texts
  const s = loadSettings(projectWith('exports:\n- *:: $defs\n- *:: tags\n'));
  assert.deepEqual(s.exports, ['*:: $defs', '*:: tags']);
});

test('writeSettingKey sets one key surgically, preserving comments + other fields; round-trips', () => {
  const root = projectWith('# my config\nuri: ::: acme.example\ntags: *:: tags\n');
  writeSettingKey(root, 'annotation-tag', '*:: yamlover: tags: colors: yellow');
  const src = readFileSync(join(root, '.yamlover', 'settings.yamlover'), 'utf8');
  assert.ok(src.includes('# my config')); // comment preserved
  assert.ok(src.includes('tags: *:: tags')); // other field preserved
  assert.ok(src.includes('annotation-tag: *:: yamlover: tags: colors: yellow'));
  assert.equal(loadSettings(root).annotationTag, ':yamlover:tags:colors:yellow');
  // replacing it in place does not duplicate the key
  writeSettingKey(root, 'annotation-tag', '*:: tags: hot');
  const src2 = readFileSync(join(root, '.yamlover', 'settings.yamlover'), 'utf8');
  assert.equal(src2.match(/^annotation-tag:/gm)?.length, 1);
  assert.equal(loadSettings(root).annotationTag, ':tags:hot');
  rmSync(root, { recursive: true, force: true });
});

test('ensureSettingsFile creates a defaults file when absent (and it loads to the defaults); idempotent, never clobbers', () => {
  // absent → created, tagged as a config node, parsing back to the DEFAULT_SETTINGS values
  const root = projectWith(null);
  assert.equal(existsSync(join(root, '.yamlover', 'settings.yamlover')), false);
  ensureSettingsFile(root);
  const created = readFileSync(join(root, '.yamlover', 'settings.yamlover'), 'utf8');
  assert.ok(created.includes('!!<*yamlover:$defs:config>')); // renders with the settings editor
  const s = loadSettings(root);
  assert.equal(s.annotations, DEFAULT_SETTINGS.annotations);
  assert.equal(s.tags, DEFAULT_SETTINGS.tags);
  assert.equal(s.sidecars, DEFAULT_SETTINGS.sidecars);
  // present → left exactly as-is (hand edits survive)
  const hand = projectWith('# mine\ntags: *:: my: tags\n');
  ensureSettingsFile(hand);
  assert.equal(readFileSync(join(hand, '.yamlover', 'settings.yamlover'), 'utf8'), '# mine\ntags: *:: my: tags\n');
  rmSync(root, { recursive: true, force: true });
  rmSync(hand, { recursive: true, force: true });
});

test('sidecars: defaults to per-directory; reads both modes (document alias too); garbage → default', () => {
  assert.equal(loadSettings(projectWith(null)).sidecars, 'per-directory');
  assert.equal(loadSettings(projectWith('sidecars: project\n')).sidecars, 'project');
  assert.equal(loadSettings(projectWith('sidecars: per-directory\n')).sidecars, 'per-directory');
  assert.equal(loadSettings(projectWith('sidecars: document\n')).sidecars, 'per-directory'); // alias
  assert.equal(loadSettings(projectWith('sidecars: nonsense\n')).sidecars, 'per-directory'); // → default
});
