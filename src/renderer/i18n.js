// UI strings. French and English from day one; the OS language picks one.
// `{name}` placeholders are filled by t().

const strings = {
	en: {
		loading: 'Loading…',
		'signin.title': 'Welcome to Kiri Studio',
		'signin.lead': 'Sign in with your GitHub account to edit your website.',
		'signin.button': 'Sign in with GitHub',
		'signin.codeTitle': 'Almost there',
		'signin.codeLead': 'GitHub just opened in your browser, and this code is already copied. Paste it on that page, then approve.',
		'signin.waiting': 'Waiting for your approval…',
		'signin.reopen': 'Open the GitHub page again',
		'signin.expired': 'The code expired before it was used.',
		'signin.denied': 'Sign-in was cancelled on GitHub.',
		'signin.failed': 'Sign-in didn’t work.',
		'signin.retry': 'Try again',
		'sites.title': 'Your websites',
		'sites.lead': 'Choose the website you want to edit.',
		'sites.none': 'No website is ready for you yet. Ask the person who built your website to give you access.',
		'sites.refresh': 'Check again',
		'ws.pages': 'Pages',
		'ws.images': 'Images',
		'ws.files': 'Documents',
		'ws.empty': 'Choose what you want to edit on the left.',
		'ws.viewSite': 'View website',
		'ws.switch': 'Other websites',
		'ws.publish': 'Publish',
		'ws.signOut': 'Sign out',
		'ws.readOnly': 'Read-only for now: editing comes in the next version.',
		'ws.mainFolder': 'Main folder',
		'ws.folderEmpty': 'This folder is empty.',
		'ws.fileCount': '{count} files',
		'ws.fileCountOne': '1 file',
		'sync.checking': 'Looking for updates…',
		'sync.downloading': 'Updating your website…',
		'sync.ready': 'Up to date',
		'sync.offline': 'Offline: showing the last version',
		'error.offline': 'Can’t reach GitHub. Check your internet connection.',
		'error.generic': 'Something went wrong.',
		'error.retry': 'Try again',
	},
	fr: {
		loading: 'Chargement…',
		'signin.title': 'Bienvenue dans Kiri Studio',
		'signin.lead': 'Connectez-vous avec votre compte GitHub pour modifier votre site web.',
		'signin.button': 'Se connecter avec GitHub',
		'signin.codeTitle': 'Presque terminé',
		'signin.codeLead': 'GitHub vient de s’ouvrir dans votre navigateur et ce code est déjà copié. Collez-le sur cette page, puis approuvez.',
		'signin.waiting': 'En attente de votre approbation…',
		'signin.reopen': 'Rouvrir la page GitHub',
		'signin.expired': 'Le code a expiré avant d’être utilisé.',
		'signin.denied': 'La connexion a été annulée sur GitHub.',
		'signin.failed': 'La connexion n’a pas fonctionné.',
		'signin.retry': 'Réessayer',
		'sites.title': 'Vos sites web',
		'sites.lead': 'Choisissez le site que vous voulez modifier.',
		'sites.none': 'Aucun site n’est encore prêt pour vous. Demandez à la personne qui a créé votre site de vous donner accès.',
		'sites.refresh': 'Vérifier de nouveau',
		'ws.pages': 'Pages',
		'ws.images': 'Images',
		'ws.files': 'Documents',
		'ws.empty': 'Choisissez à gauche ce que vous voulez modifier.',
		'ws.viewSite': 'Voir le site',
		'ws.switch': 'Autres sites',
		'ws.publish': 'Publier',
		'ws.signOut': 'Se déconnecter',
		'ws.readOnly': 'Lecture seule pour l’instant : la modification arrive dans la prochaine version.',
		'ws.mainFolder': 'Dossier principal',
		'ws.folderEmpty': 'Ce dossier est vide.',
		'ws.fileCount': '{count} fichiers',
		'ws.fileCountOne': '1 fichier',
		'sync.checking': 'Recherche de mises à jour…',
		'sync.downloading': 'Mise à jour de votre site…',
		'sync.ready': 'À jour',
		'sync.offline': 'Hors ligne : dernière version affichée',
		'error.offline': 'Impossible de joindre GitHub. Vérifiez votre connexion Internet.',
		'error.generic': 'Un problème est survenu.',
		'error.retry': 'Réessayer',
	},
};

let lang = 'en';

export function setLocale(locale) {
	lang = String(locale).toLowerCase().startsWith('fr') ? 'fr' : 'en';
	document.documentElement.lang = lang;
}

export function t(key, params = {}) {
	const text = strings[lang][key] ?? strings.en[key] ?? key;
	return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

export const fileCount = (count) => (count === 1 ? t('ws.fileCountOne') : t('ws.fileCount', { count }));
