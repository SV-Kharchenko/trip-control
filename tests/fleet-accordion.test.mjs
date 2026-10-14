import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function grab(name) {
    const match = html.match(new RegExp('function ' + name + '\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n    \\}'));
    assert.ok(match, name + ' is missing from index.html');
    const args = match[0].slice(match[0].indexOf('(') + 1, match[0].indexOf(')'));
    return new Function(...args.split(',').map((part) => part.trim()).filter(Boolean), match[1]);
}

const fleetCardStatus = grab('fleetCardStatus');

test('a collapsed fleet card names overdue, soon, or a check', () => {
    assert.deepEqual(fleetCardStatus(1, 2), { text: '⚠ 1 прострочено', tone: 'overdue' });
    assert.deepEqual(fleetCardStatus(3, 0), { text: '⚠ 3 прострочено', tone: 'overdue' });
    assert.deepEqual(fleetCardStatus(0, 2), { text: 'скоро: 2', tone: 'soon' });
    assert.deepEqual(fleetCardStatus(0, 0), { text: '✓', tone: 'ok' });
});

test('fleet cards collapse by default and keep the form in the page', () => {
    assert.match(html, /Розгорнути всі/);
    assert.match(html, /Згорнути всі/);
    assert.match(html, /без марки/);
    assert.match(html, /aria-expanded/);
    assert.match(html, /aria-controls/);
    assert.match(html, /tc_fleet_card_open/);
    assert.match(html, /return readFleetOpenMap\(\)\[id\] === true/);
    const toggle = html.slice(html.indexOf('function toggleFleetCard'), html.indexOf('function setAllFleetCardsOpen'));
    assert.equal(toggle.includes('renderFleetDocs'), false);
    assert.match(toggle, /applyFleetCardOpen/);
    const render = html.slice(html.indexOf('function renderFleetDocs'), html.indexOf('async function loadFleetVehicles'));
    assert.match(render, /tc-fleet-body/);
    assert.match(render, /hidden/);
    assert.match(render, /fleetNormMarkup/);
    assert.match(render, /Зберегти/);
    assert.match(render, /Видалити/);
    const add = html.slice(html.indexOf('async function addFleetVehicle'), html.indexOf('function readFleetDates'));
    assert.equal(add.split('setFleetCardOpen').length - 1, 2);
    const save = html.slice(html.indexOf('async function saveFleetVehicle'), html.indexOf('async function removeFleetVehicle'));
    assert.equal(save.split('setFleetCardOpen').length - 1, 3);
    assert.equal(save.includes('calculate('), false);
    assert.match(html, /#cabinet-screen \.tc-fleet-plate[\s\S]*text-transform: uppercase/);
    assert.match(html, /#cabinet-screen \.tc-fleet-make\.is-empty \{ color: var\(--muted\)/);
    assert.match(html, /#cabinet-screen \.tc-fleet-status\.is-overdue \{ color: var\(--negative\)/);
    assert.match(html, /#cabinet-screen \.tc-fleet-status\.is-soon \{ color: var\(--warning-text\)/);
    assert.match(html, /#cabinet-screen \.tc-doc-soon,\s*#cabinet-screen \.tc-doc-soon small \{ color: var\(--warning-text\)/);
    assert.match(html, /#cabinet-screen \.tc-fleet-card\.is-soon \{ border-color: var\(--warning\)/);
});
