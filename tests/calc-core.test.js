import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateTrip } from '../api/_lib/calc-core.js';

const fixtureUrl = new URL('./fixtures/calc-golden.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));

for (const [name, scenario] of Object.entries(fixture.cases)) {
    test(`golden calculation: ${name}`, () => {
        const input = { ...fixture.base, ...scenario.input };
        const snapshot = structuredClone(input);
        const { demo: _demo, ...expected } = scenario.expected;

        assert.deepStrictEqual(calculateTrip(input), expected);
        assert.deepStrictEqual(input, snapshot, 'calculation core must not mutate its input');
    });
}
