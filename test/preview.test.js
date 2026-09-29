import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagePath } from '../src/renderer/preview-pane.js';

test('pagePath maps a page file to its URL path, like Kirigami names outputs', () => {
	assert.equal(pagePath('src', 'src/_index.php'), '');
	assert.equal(pagePath('src', 'src/about/_index.php'), 'about/');
	assert.equal(pagePath('src', 'src/features/data/_index.php'), 'features/data/');
	assert.equal(pagePath('src', 'src/_contact.php'), 'contact.html');
	assert.equal(pagePath('.', 'blog/_index.php'), 'blog/');
	assert.equal(pagePath('src', null), null);
});
