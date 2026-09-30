import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerInfo, joinHeader, newHeader, removeTag, setTag, splitHeader } from '../src/shared/md-header.js';

test('splitHeader reads like php-prepros FS::splitHeader()', () => {
	const text = '\n@title    Hello\n@abstract wraps\n  here\n@@type post\n\nBody\n@not a tag\n';
	const header = splitHeader(text);
	assert.deepEqual(header.tags.map(({ name, inherited, value }) => ({ name, inherited, value })), [
		{ name: 'title', inherited: false, value: 'Hello' },
		{ name: 'abstract', inherited: false, value: 'wraps here' },
		{ name: 'type', inherited: true, value: 'post' },
	]);
	assert.equal(header.body, 'Body\n@not a tag\n');
	assert.deepEqual(headerInfo(text), { title: 'Hello', abstract: 'wraps here', type: 'post' });
	assert.equal(splitHeader('# No header\n@title no'), null);
	assert.deepEqual(headerInfo('No header'), {});
});

test('joinHeader gives back the exact text; setTag rewrites one line only', () => {
	for (const text of ['@title A\n', '@title A\n\nBody', '@title A\r\n@date 2026-01-01\r\n\r\nBody\r\n', '@title A\nBody right after', '@title A']) {
		const header = splitHeader(text);
		assert.equal(joinHeader(header), text, JSON.stringify(text));
	}
	const header = splitHeader('@title    Hello\n@abstract long\n  wrapped\n@@type post\n\nBody');
	assert.equal(joinHeader(setTag(header, 'title', 'Bonjour')), '@title    Bonjour\n@abstract long\n  wrapped\n@@type post\n\nBody');
	assert.equal(joinHeader(setTag(header, 'abstract', 'short')), '@title    Hello\n@abstract short\n@@type post\n\nBody');
	assert.equal(joinHeader(setTag(header, 'draft', 'true')), '@title    Hello\n@abstract long\n  wrapped\n@@type post\n@draft true\n\nBody');
	// A new body never merges into the header.
	assert.equal(joinHeader(splitHeader('@title A'), 'Text'), '@title A\nText');
	assert.equal(joinHeader(splitHeader('@title A\nText'), '  indented'), '@title A\n\n  indented');
	assert.equal(joinHeader(splitHeader('@title A\nText'), '@mention'), '@title A\n\n@mention');
	assert.equal(joinHeader(setTag(splitHeader('@title A\r\n\r\nX'), 'title', 'B')), '@title B\r\n\r\nX');
	assert.equal(joinHeader(splitHeader('@title A\n\nOld'), 'New'), '@title A\n\nNew');
});

test('newHeader aligns the tags', () => {
	assert.equal(newHeader('Hi', { date: '2026-09-30', tags: '' }), '@title Hi\n@date  2026-09-30\n@tags\n\n');
});

test('removeTag drops a tag, keeping the rest as written', () => {
	const header = splitHeader('@title A\n@type  post\n\nBody');
	assert.equal(joinHeader(removeTag(header, 'type')), '@title A\n\nBody');
	assert.equal(joinHeader(removeTag(header, 'missing')), '@title A\n@type  post\n\nBody');
	assert.equal(joinHeader(setTag(removeTag(header, 'type'), 'type', 'note')), '@title A\n@type note\n\nBody');
});
