// The sites a signed-in user can edit: repositories the Kiri Studio App is
// installed on, that the user can push to, and whose kirigami.yaml has a
// `studio:` block. The token already limits what's visible to the App's
// installations, so this is the intersection the plan describes.
import * as yaml from 'js-yaml';

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
			config = yaml.load(await gh.text(`/repos/${repo.full_name}/contents/kirigami.yaml`));
		} catch (error) {
			if (error.status === 404 || error.name === 'YAMLException') return null;
			throw error;
		}
		if (!config || typeof config !== 'object' || !('studio' in config)) return null;
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
