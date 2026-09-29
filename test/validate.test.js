import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkData } from '../src/main/validate.js';

const schema = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	type: 'array',
	items: {
		type: 'object',
		properties: {
			name: { type: 'string', minLength: 1, description: 'Title of the publication.' },
			image: { type: 'string', pattern: '\\.(webp|jpg)$', description: 'Image file name.' },
			medias: {
				type: 'array',
				items: {
					type: 'object',
					properties: { news: { type: 'string', minLength: 1, description: 'Name of the outlet.' } },
					required: ['news'],
					additionalProperties: false,
				},
			},
		},
		required: ['name', 'image'],
		additionalProperties: false,
	},
};

// [key, params, underlined text] for each diagnostic.
const check = (text, s = schema) => checkData(text, s).map((d) => [d.key, d.params, text.slice(d.from, d.to)]);

test('a valid file has no diagnostics', () => {
	assert.deepEqual(check('- name: Charlevoix\n  image: a.webp\n  medias:\n    - news: La Presse\n'), []);
});

test('schema errors point at the right text, with the field description', () => {
	const found = check('- name: Charlevoix\n  image: a.gif\n  extra: 1\n  medias:\n    - news:\n');
	assert.deepEqual(found, [
		['check.unknown', { field: 'extra' }, 'extra'],
		['check.pattern', { field: 'image', value: '', description: 'Image file name.' }, 'a.gif'],
		['check.empty', { field: 'news', value: '', description: 'Name of the outlet.' }, 'news'],
	]);
});

test('a missing field underlines the first line of its item', () => {
	assert.deepEqual(check('- name: Charlevoix\n  medias: []\n'), [
		['check.required', { field: 'image', description: 'Image file name.' }, 'name: Charlevoix'],
	]);
});

test('only the first syntax error is reported, and the schema is skipped', () => {
	const found = check('- name: a\n   image: b\n  medias:\n - x\n');
	assert.equal(found.length, 1);
	assert.match(found[0][0], /^check\.(indent|syntax|missingChar)$/);
});

test('no schema: only syntax is checked; a broken schema is ignored', () => {
	assert.deepEqual(check('a: 1\n', null), []);
	assert.deepEqual(check('a: 1\n', { type: 'nope' }), []);
});

test('JSON files are checked the same way', () => {
	assert.deepEqual(check('[{ "name": "x", "image": "a.png" }]').map(([key]) => key), ['check.pattern']);
});
