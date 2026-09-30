import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollapseStore } from '../src/renderer/collapse.js';

const memory = () => {
	const data = new Map();
	return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
};

test('an id with no recorded choice takes the fallback', () => {
	const store = createCollapseStore('o/site', memory());
	assert.equal(store.isOpen('src/a/**/_index.md', true), true);
	assert.equal(store.isOpen('src/a/x/_index.md', false), false);
});

test('a choice is remembered, per site', () => {
	const storage = memory();
	createCollapseStore('o/one', storage).set('group', false);
	assert.equal(createCollapseStore('o/one', storage).isOpen('group', true), false);
	assert.equal(createCollapseStore('o/two', storage).isOpen('group', true), true);
});

test('a missing, broken or throwing storage never breaks the sidebar', () => {
	assert.equal(createCollapseStore('o/site', null).isOpen('x', true), true);
	assert.equal(createCollapseStore('o/site', { getItem: () => '{not json', setItem() {} }).isOpen('x', false), false);
	assert.equal(createCollapseStore('o/site', { getItem: () => '[1,2]', setItem() {} }).isOpen('x', true), true);

	const store = createCollapseStore('o/site', { getItem: () => null, setItem() { throw new Error('full'); } });
	store.set('x', false);
	assert.equal(store.isOpen('x', true), false); // still applied for this session
});
