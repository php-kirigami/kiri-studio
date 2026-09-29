import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { yamlEnter } from '../src/renderer/yaml-indent.js';

// Presses Enter at the end of `text` (or at "|") and returns the result, with
// "|" marking where the cursor lands.
function enter(text) {
	const at = text.includes('|') ? text.indexOf('|') : text.length;
	const view = {
		state: EditorState.create({ doc: text.replace('|', ''), selection: { anchor: at } }),
		dispatch(spec) { this.state = this.state.update(spec).state; },
	};
	assert.equal(yamlEnter(view), true);
	const doc = view.state.doc.toString();
	const head = view.state.selection.main.head;
	return `${doc.slice(0, head)}|${doc.slice(head)}`;
}

test('a key with no value opens an indented block', () => {
	assert.equal(enter('medias:'), 'medias:\n  |');
	assert.equal(enter('  medias:'), '  medias:\n    |');
});

test('a list item holding fields: the next line lines up under its key', () => {
	assert.equal(enter('- name: Charlevoix'), '- name: Charlevoix\n  |');
	assert.equal(enter('    - name: La Presse'), '    - name: La Presse\n      |');
});

test('a list item holding a block key: one level deeper than its key', () => {
	assert.equal(enter('- medias:'), '- medias:\n    |');
});

test('a plain list continues with a new item', () => {
	assert.equal(enter('keywords:\n  - ethnographie'), 'keywords:\n  - ethnographie\n  - |');
});

test('Enter on an empty item ends the list', () => {
	assert.equal(enter('keywords:\n  - ethnographie\n  - '), 'keywords:\n  - ethnographie\n|');
});

test('a key with a value keeps the same level', () => {
	assert.equal(enter('  date: mai 2026'), '  date: mai 2026\n  |');
	assert.equal(enter('title: "Parc : 3 réalités"'), 'title: "Parc : 3 réalités"\n|');
});

test('a URL value is not mistaken for a key', () => {
	assert.equal(enter('  - https://example.com/a'), '  - https://example.com/a\n  - |');
});

test('Enter in the middle of a line splits it at the same level', () => {
	assert.equal(enter('  news: Le| Charlevoisien'), '  news: Le\n  | Charlevoisien');
});
