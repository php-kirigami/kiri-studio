// HTTP Range for files the app serves from memory (the `studio-media:`
// protocol). A browser only lets someone jump around in an <audio> or <video>
// when the server answers Range requests with 206 and a Content-Range; without
// that, a click on the timeline goes back to the start.

// Parses one `Range: bytes=…` header against a file of `size` bytes. Returns
// undefined when there is nothing to honour (no header, another unit, several
// ranges, a malformed value: the whole file is sent), null when the range
// cannot be satisfied (416), or { start, end } (inclusive).
export function parseRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
	if (!match || (match[1] === '' && match[2] === '')) return undefined;
	let start;
	let end;
	if (match[1] === '') {
		// "-500": the last 500 bytes.
		start = Math.max(0, size - Number(match[2]));
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	return start >= size || start > end ? null : { start, end };
}

// A Response for `data` (a Buffer), honouring the request's Range header.
export function bytesResponse(data, headers, rangeHeader) {
	const size = data.length;
	const base = { ...headers, 'Accept-Ranges': 'bytes' };
	const range = parseRange(rangeHeader, size);
	if (range === null) {
		return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
	}
	if (!range) return new Response(data, { headers: { ...base, 'Content-Length': String(size) } });
	const part = data.subarray(range.start, range.end + 1);
	return new Response(part, {
		status: 206,
		headers: { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(part.length) },
	});
}
