import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, DEFAULT_SETTINGS } from '../src/settings.ts';

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

test('annotations.location is read and normalized (leading /, trailing / stripped)', () => {
  const root = projectWith('annotations:\n  location: notes/marks/\n');
  assert.equal(loadSettings(root).annotations.location, '/notes/marks');
  rmSync(root, { recursive: true, force: true });
});

test('unsafe or empty locations fall back to the default', () => {
  for (const bad of ['annotations:\n  location: ../outside\n', 'annotations:\n  location: "/"\n', 'annotations:\n  location: ""\n']) {
    const root = projectWith(bad);
    assert.equal(loadSettings(root).annotations.location, DEFAULT_SETTINGS.annotations.location);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unparsable settings file yields the defaults (never breaks serving)', () => {
  const root = projectWith(':: not yamlover {{{');
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
  rmSync(root, { recursive: true, force: true });
});
