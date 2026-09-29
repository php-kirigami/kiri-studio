// Git LFS without Git: pointer files, and GitHub's LFS batch API to upload or
// download the objects they stand for.
//
// A tracked file is committed as a three-line pointer:
//   version https://git-lfs.github.com/spec/v1
//   oid sha256:<64 hex>
//   size <bytes>
// and its bytes live in LFS storage under that oid. The synced copy of a site
// (a repository tarball) holds the pointers, not the bytes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const POINTER_HEAD = 'version https://git-lfs.github.com/spec/v1';
const LFS_TYPE = 'application/vnd.git-lfs+json';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function pointerFor(bytes) {
	const oid = sha256(bytes);
	return { oid, size: bytes.length, text: `${POINTER_HEAD}\noid sha256:${oid}\nsize ${bytes.length}\n` };
}

// { oid, size } when `bytes` is a pointer file, else null. Pointers are tiny,
// so anything bigger is never one.
export function parsePointer(bytes) {
	if (!bytes || bytes.length > 512) return null;
	const text = Buffer.from(bytes).toString('utf8');
	if (!text.startsWith(POINTER_HEAD)) return null;
	const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
	const size = /^size (\d+)$/m.exec(text)?.[1];
	return oid && size ? { oid, size: Number(size) } : null;
}

export class LfsError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'LfsError';
		this.status = status;
	}
}

// `fullName`: "owner/repo". Basic auth with the token as the password is what
// GitHub documents for tokens on the LFS endpoint.
export function createLfs(token, fullName, { fetchImpl = fetch, baseUrl = 'https://github.com' } = {}) {
	const endpoint = `${baseUrl}/${fullName}.git/info/lfs`;
	const auth = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

	async function batch(operation, objects, branch) {
		let res;
		try {
			res = await fetchImpl(`${endpoint}/objects/batch`, {
				method: 'POST',
				headers: { Authorization: auth, Accept: LFS_TYPE, 'Content-Type': LFS_TYPE },
				body: JSON.stringify({
					operation,
					transfers: ['basic'],
					objects,
					...(branch && { ref: { name: `refs/heads/${branch}` } }),
					hash_algo: 'sha256',
				}),
			});
		} catch (error) {
			throw new LfsError(`Network error on Git LFS: ${error.message}`, 0);
		}
		if (!res.ok) throw new LfsError(`Git LFS answered ${res.status} (${operation})`, res.status);
		return (await res.json()).objects ?? [];
	}

	const check = (object) => {
		if (object.error) throw new LfsError(`Git LFS refused ${object.oid}: ${object.error.message}`, object.error.code);
	};

	return {
		// Uploads the objects LFS doesn't have yet. `items`: [{ oid, size, bytes }].
		async upload(items, branch) {
			if (!items.length) return;
			const answers = await batch('upload', items.map(({ oid, size }) => ({ oid, size })), branch);
			for (const answer of answers) {
				check(answer);
				const item = items.find((i) => i.oid === answer.oid);
				const put = answer.actions?.upload;
				if (!put) continue; // already stored
				let res;
				try {
					res = await fetchImpl(put.href, { method: 'PUT', headers: put.header ?? {}, body: item.bytes });
				} catch (error) {
					throw new LfsError(`Network error uploading ${answer.oid}: ${error.message}`, 0);
				}
				if (!res.ok) throw new LfsError(`Git LFS storage answered ${res.status} for ${answer.oid}`, res.status);
				const verify = answer.actions?.verify;
				if (verify) {
					const check = await fetchImpl(verify.href, {
						method: 'POST',
						headers: { ...(verify.header ?? {}), Accept: LFS_TYPE, 'Content-Type': LFS_TYPE },
						body: JSON.stringify({ oid: item.oid, size: item.size }),
					});
					if (!check.ok) throw new LfsError(`Git LFS could not verify ${answer.oid} (${check.status})`, check.status);
				}
			}
		},

		// The bytes of one object.
		async download({ oid, size }, branch) {
			const [answer] = await batch('download', [{ oid, size }], branch);
			check(answer);
			const get = answer.actions?.download;
			if (!get) throw new LfsError(`Git LFS has no download for ${oid}`, 404);
			let res;
			try {
				res = await fetchImpl(get.href, { headers: get.header ?? {} });
			} catch (error) {
				throw new LfsError(`Network error downloading ${oid}: ${error.message}`, 0);
			}
			if (!res.ok) throw new LfsError(`Git LFS storage answered ${res.status} for ${oid}`, res.status);
			return Buffer.from(await res.arrayBuffer());
		},
	};
}

// A local cache of LFS objects, <siteDir>/lfs/<oid>: what the client uploaded,
// or what was downloaded to show a file. The synced copy only has pointers.
export function createLfsStore(dir, lfs, branch) {
	const file = (oid) => path.join(dir, oid);
	const store = {
		remember(oid, bytes) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file(oid), bytes);
		},
		// The bytes of the pointer's object, from the cache or from LFS.
		async resolve(pointer) {
			if (fs.existsSync(file(pointer.oid))) return fs.readFileSync(file(pointer.oid));
			const bytes = await lfs.download(pointer, branch);
			if (sha256(bytes) !== pointer.oid) throw new LfsError(`Git LFS sent the wrong bytes for ${pointer.oid}`, 502);
			store.remember(pointer.oid, bytes);
			return bytes;
		},
	};
	return store;
}
