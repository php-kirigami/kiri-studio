// The sites a signed-in user can edit: repositories the Kiri Studio App is
// installed on, that the user can push to, and that have a kirigami.yaml.
// The token already limits what's visible to the App's installations, so
// installing the App on a repo is what opens it to Kiri Studio. A `studio:`
// block is optional: it narrows and labels what's editable (scope.js).
import * as yaml from 'yaml';

// Where a user picks more repositories for the App ("Add a site").
export const INSTALL_URL = 'https://github.com/apps/kiri-studio/installations/new';

export async function listSites(gh) {
	const repos = [];
	for await (const installation of gh.paginate('/user/installations', 'installations')) {
		for await (const repo of gh.paginate(`/user/installations/${installation.id}/repositories`, 'repositories')) {
			if (repo.permissions?.push && !repo.archived) repos.push(repo);
		}
	}

	const sites = await Promise.all(repos.map(async (repo) => {
		let config;
		try {
			config = yaml.parse(await gh.text(`/repos/${repo.full_name}/contents/kirigami.yaml`));
		} catch (error) {
			if (error.status === 404 || error.name === 'YAMLParseError') return null;
			throw error;
		}
		if (!config || typeof config !== 'object') return null;
		return {
			fullName: repo.full_name,
			owner: repo.owner.login,
			name: repo.name,
			title: config.kirigami?.project || repo.name,
			url: config.kirigami?.baseurl || null,
			branch: config.studio?.branch || repo.default_branch,
		};
	}));

	return sites.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
}
