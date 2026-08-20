/**
 * Regenerate `vocabulary.generated.js` from design/settings-inventory.md.
 *
 *   node platform/src/modules/profile/generateVocabulary.mjs
 *
 * The server must not read a design document at runtime, and the validator must not be
 * hand-maintained (http-api.md §11.9). A generated, committed artefact is the only shape that
 * satisfies both — and `profiletest.mjs` re-runs the parse and fails if the artefact is stale,
 * so "someone forgot to regenerate" is a red test rather than a silent divergence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSettingsInventory } from './settingsVocabularyParser.js';

const here = dirname(fileURLToPath(import.meta.url));
export const INVENTORY_PATH = resolve(here, '../../../../docs/design/settings-inventory.md');
export const GENERATED_PATH = resolve(here, 'vocabulary.generated.js');

export function renderVocabulary(vocab) {
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Source:    docs/design/settings-inventory.md (vocabulary version ${vocab.vocabularyVersion})
 * Generator: platform/src/modules/profile/generateVocabulary.mjs
 *
 * RoamingSettingsV1 is defined by http-api.md §11.9 as "exactly the rows of the inventory whose
 * Scope is ROAM". This file IS that projection, machine-derived, so the validator cannot
 * disagree with the design document.
 */
export const VOCABULARY = ${JSON.stringify(vocab, null, 2)};

export default VOCABULARY;
`;
}

export function buildVocabulary() {
  return parseSettingsInventory(readFileSync(INVENTORY_PATH, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const vocab = buildVocabulary();
  writeFileSync(GENERATED_PATH, renderVocabulary(vocab));
  const roam = Object.keys(vocab.roam).length;
  const binds = Object.keys(vocab.keybinds).length;
  console.log(`vocabulary v${vocab.vocabularyVersion}: ${roam} ROAM keys, ${binds} binding actions`);
}
