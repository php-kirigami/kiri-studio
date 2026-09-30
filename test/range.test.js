import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bytesResponse, parseRange } from '../src/main/lib/range.js';

const data = Buffer.from('0123456789');

test('parseRange reads a single byte range and ignores anything else', () => {
	assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
	assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
	assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
	assert.deepEqual(parseRange('bytes=8-99', 10), { start: 8, end: 9 }, 'an end past the file is clamped');
	assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
	assert.equal(parseRange('bytes=10-', 10), null, 'starting past the end cannot be satisfied');
	assert.equal(parseRange('bytes=5-2', 10), null);
	for (const ignored of [undefined, null, '', 'items=1-2', 'bytes=0-1,4-5', 'bytes=-', 'bytes=a-b']) {
		assert.equal(parseRange(ignored, 10), undefined, String(ignored));
	}
});

test('bytesResponse sends the whole file, or 206 with the right slice, or 416', async () => {
	const headers = { 'Content-Type': 'audio/mpeg' };

	const full = bytesResponse(data, headers, null);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get('accept-ranges'), 'bytes');
	assert.equal(full.headers.get('content-length'), '10');
	assert.equal(full.headers.get('content-type'), 'audio/mpeg');
	assert.equal(await full.text(), '0123456789');

	const part = bytesResponse(data, headers, 'bytes=2-5');
	assert.equal(part.status, 206);
	assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
	assert.equal(part.headers.get('content-length'), '4');
	assert.equal(await part.text(), '2345');

	const tail = bytesResponse(data, headers, 'bytes=-3');
	assert.equal(await tail.text(), '789');

	const past = bytesResponse(data, headers, 'bytes=10-');
	assert.equal(past.status, 416);
	assert.equal(past.headers.get('content-range'), 'bytes */10');

	assert.equal(bytesResponse(data, headers, 'bytes=0-1,4-5').status, 200, 'several ranges: the whole file');
});

test('an empty file is sent whole, and every range on it is refused', async () => {
	const empty = Buffer.alloc(0);
	assert.equal(bytesResponse(empty, {}, null).status, 200);
	assert.equal(bytesResponse(empty, {}, 'bytes=0-').status, 416);
});
