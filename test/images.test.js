import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { imageCode } from '../src/renderer/media-view.js';
import { insertBlock } from '../src/renderer/markdown-editor.js';

const scope = { imageSource: 'assets/images', imageWidth: 800 };

test('imageCode: {% img-asset %} with the path relative to image.source', () => {
	assert.equal(imageCode(scope, 'assets/images/team/ada.png'), '{% img-asset team/ada.png 800 %}');
	assert.equal(imageCode({ ...scope, imageWidth: 640 }, 'assets/images/cover.jpg'), '{% img-asset cover.jpg 640 %}');
	assert.equal(imageCode(scope, 'src/documents/menu.pdf'), null, 'outside image.source: no code');
	assert.equal(imageCode(scope, 'assets/images-old/x.png'), null);
});

// Inserts at "|" and returns the text with "|" where the cursor lands.
function insert(text, block) {
	const at = text.indexOf('|');
	const view = {
		state: EditorState.create({ doc: text.replace('|', ''), selection: { anchor: at } }),
		dispatch(spec) { this.state = this.state.update(spec).state; },
		focus() {},
	};
	insertBlock(view, block);
	const doc = view.state.doc.toString();
	const head = view.state.selection.main.head;
	return `${doc.slice(0, head)}|${doc.slice(head)}`;
}

test('insertBlock puts the code on a paragraph of its own', () => {
	assert.equal(insert('Intro.\n|', 'IMG'), 'Intro.\nIMG\n|');
	assert.equal(insert('Intro.|', 'IMG'), 'Intro.\n\nIMG\n|');
	assert.equal(insert('Before| after', 'IMG'), 'Before\n\nIMG\n\n| after');
});
