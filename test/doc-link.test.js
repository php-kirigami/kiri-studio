import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentLink } from '../src/shared/doc-link.js';

const scope = { root: 'src', basePath: '' };

test('document link: path from the site root, name without extension', () => {
	assert.equal(documentLink(scope, 'src/publications/rapports/report.pdf'), '[report](/publications/rapports/report.pdf)');
});

test('document link: spaces, accents and parentheses are percent-encoded', () => {
	assert.equal(
		documentLink(scope, 'src/publications/rapports/RAPPORT FINAL_HH_29déc2025 (v2).pdf'),
		'[RAPPORT FINAL_HH_29déc2025 (v2)](/publications/rapports/RAPPORT%20FINAL_HH_29d%C3%A9c2025%20%28v2%29.pdf)');
});

test('document link: keeps the path of baseurl for a site in a sub-folder', () => {
	assert.equal(documentLink({ root: 'src', basePath: '/repo' }, 'src/docs/a.pdf'), '[a](/repo/docs/a.pdf)');
});

test('document link: brackets in the name are escaped; none outside the root', () => {
	assert.equal(documentLink(scope, 'src/docs/[draft].pdf'), '[\\[draft\\]](/docs/%5Bdraft%5D.pdf)');
	assert.equal(documentLink(scope, 'other/a.pdf'), null);
});
