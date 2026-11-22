import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseShareHash, serializeShareState, SLIDER_KEYS } from '../../src/state/share-link.js';

const STATE = { shape: 2, palette: 3, scale: 18, gravity: 1.15, jetPower: 0.85, chaos: 0.18, speed: 0.55, psize: 2.25, bloom: 0.45 };

describe('serializeShareState', () => {
    test('emits every key in a stable order', () => {
        assert.equal(serializeShareState(STATE), 't=2&p=3&sc=18&g=1.15&jp=0.85&ch=0.18&sp=0.55&ps=2.25&bl=0.45');
    });

    test('rounds sliders to two decimals and topology to an integer', () => {
        const s = serializeShareState({ ...STATE, shape: 2.6, chaos: 0.123456 });
        assert.match(s, /^t=3&/);
        assert.match(s, /ch=0\.12(&|$)/);
    });
});

describe('parseShareHash', () => {
    test('round-trips a serialized state', () => {
        const parsed = parseShareHash(`#${serializeShareState(STATE)}`);
        assert.equal(parsed.topology, 2);
        assert.equal(parsed.palette, 3);
        for (const id of Object.values(SLIDER_KEYS)) assert.equal(parsed.sliders[id], STATE[id]);
    });

    test('accepts a hash with or without the leading #', () => {
        assert.deepEqual(parseShareHash('ch=1.5'), parseShareHash('#ch=1.5'));
    });

    test('empty and missing hashes yield nothing', () => {
        for (const h of ['', '#', '#x', undefined, null, 42]) {
            assert.deepEqual(parseShareHash(h), { sliders: {} });
        }
    });

    test('drops non-numeric values individually', () => {
        const p = parseShareHash('#ch=NOTANUMBER&sc=30');
        assert.equal(p.sliders.chaos, undefined);
        assert.equal(p.sliders.scale, 30);
    });

    test('REGRESSION: an absent topology key does not reset the topology', () => {
        // Number(null) === 0 used to pass the range check, so any shared link without
        // `t` silently morphed back to topology 0.
        assert.equal(parseShareHash('#ch=1').topology, undefined);
        assert.equal(parseShareHash('#t=&ch=1').topology, undefined);
    });

    test('an empty slider value is ignored rather than read as 0', () => {
        assert.equal(parseShareHash('#ch=&sc=20').sliders.chaos, undefined);
    });

    test('rejects out-of-range topology and palette', () => {
        const p = parseShareHash('#t=999&p=-1');
        assert.equal(p.topology, undefined);
        assert.equal(p.palette, undefined);
        assert.equal(parseShareHash('#t=-0.6').topology, undefined);
        assert.equal(parseShareHash('#p=5').palette, undefined);
    });

    test('palette must be an integer; topology rounds', () => {
        assert.equal(parseShareHash('#p=1.5').palette, undefined);
        assert.equal(parseShareHash('#t=4.6').topology, 5);
    });

    test('leaves slider clamping to the slider layer', () => {
        assert.equal(parseShareHash('#g=999').sliders.gravity, 999);
    });

    test('ignores unknown keys and prototype-like keys', () => {
        const p = parseShareHash('#__proto__=1&constructor=2&ch=0.5');
        assert.deepEqual(Object.keys(p.sliders), ['chaos']);
    });
});
