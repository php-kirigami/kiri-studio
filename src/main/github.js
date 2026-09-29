// Minimal GitHub REST client on fetch(). Every call carries the signed-in
// user's token; failures throw a GitHubError with the HTTP status (0 when the
// network itself failed), so callers can tell "offline" from "not found".

const API = 'https://api.github.com';

export class GitHubError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'GitHubError';
		this.status = status;
	}
}

export function createClient(token) {
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'kiri-studio',
	};

	async function request(pathOrUrl, { accept } = {}) {
		const url = pathOrUrl.startsWith('https://') ? pathOrUrl : API + pathOrUrl;
		// Smoke tests: behave as if there were no internet.
		if (process.env.KIRI_STUDIO_OFFLINE) throw new GitHubError(`Offline (test) on ${url}`, 0);
		let res;
		try {
			res = await fetch(url, { headers: { ...headers, ...(accept && { Accept: accept }) } });
		} catch (error) {
			throw new GitHubError(`Network error on ${url}: ${error.message}`, 0);
		}
		if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} on ${url}`, res.status);
		return res;
	}

	return {
		async json(path) {
			return (await request(path)).json();
		},

		// Raw file contents by default; pass another media type for e.g. a bare SHA.
		async text(path, accept = 'application/vnd.github.raw') {
			return (await request(path, { accept })).text();
		},

		async buffer(path) {
			return Buffer.from(await (await request(path)).arrayBuffer());
		},

		// Yields every item of a paginated list; `key` picks the array out of
		// wrapped responses such as { installations: [...] }.
		async *paginate(path, key) {
			let url = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
			while (url) {
				const res = await request(url);
				const body = await res.json();
				yield* key ? body[key] : body;
				url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
			}
		},
	};
}
