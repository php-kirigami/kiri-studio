// The `@tag value` header of a Markdown page (title, date, summary, tags…)
// shown as a small form above the text, so the client never edits the
// header's syntax. Technical tags (the page type, layout knobs, `@@` values
// passed to child pages, anything with an underscore like `ld_type`) are
// kept as they are and not shown.
import { h } from './dom.js';
import { t } from './i18n.js';

const HIDDEN = new Set(['type', 'content', 'indent', 'position', 'breadcrumb', 'robots', 'image', 'meta', 'canonical']);
const LONG = new Set(['abstract', 'description', 'summary']);

// The tags the client edits, in header order.
export function visibleTags(header) {
	return (header?.tags ?? []).filter((tag) => tag.name && !tag.inherited && !HIDDEN.has(tag.name) && !tag.name.includes('_'));
}

// "abstract" → "Summary" (translated when known, else the name, capitalized).
function fieldLabel(name) {
	const key = `field.${name}`;
	const known = t(key);
	return known !== key ? known : name[0].toUpperCase() + name.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

// createPageFields(header, onField, { types }) → an element, or null when
// nothing is editable. `onField(name, value)` fires on every change; a null
// value removes the tag. `types`: the page types the client may pick
// (`prepros.types`, narrowed by `studio.types`), shown as an optional choice.
export function createPageFields(header, onField, { types = [] } = {}) {
	const tags = visibleTags(header);
	const typeField = types.length > 0 && pageTypeField(header, types, onField);
	if (!tags.length && !typeField) return null;
	return h('div.page-fields', tags.map((tag) => field(tag, onField)), typeField);
}

// "Default" leaves the page without a type of its own (it keeps the one its
// section passes down, if any); another choice writes `@type <name>`.
function pageTypeField(header, types, onField) {
	const own = header.tags.find((tag) => tag.name === 'type')?.value ?? '';
	const names = own && !types.includes(own) ? [...types, own] : types;
	const label = (name) => name[0].toUpperCase() + name.slice(1).replace(/[-_]+/g, ' ');
	return h('div.page-field', { dataset: { name: 'type' } },
		h('label', { for: 'page-field-type' }, t('field.type')),
		h('select', { id: 'page-field-type', onchange: (e) => onField('type', e.target.value || null) },
			h('option', { value: '', selected: own === '' }, t('field.typeDefault')),
			names.map((name) => h('option', { value: name, selected: own === name }, label(name)))));
}

function field(tag, onField) {
	const id = `page-field-${tag.name}`;
	const label = fieldLabel(tag.name);
	if (/^(true|false)$/i.test(tag.value)) {
		return h('label.page-field.check',
			h('input', { id, type: 'checkbox', checked: /^true$/i.test(tag.value), onchange: (e) => onField(tag.name, e.target.checked ? 'true' : 'false') }),
			label);
	}
	const input = LONG.has(tag.name)
		? h('textarea', { id, rows: 2, oninput: (e) => onField(tag.name, e.target.value) }, tag.value)
		: h('input', {
			id,
			type: tag.name === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(tag.value) ? 'date' : 'text',
			value: tag.value,
			oninput: (e) => onField(tag.name, e.target.value),
		});
	return h('div.page-field', { dataset: { name: tag.name } },
		h('label', { for: id }, label),
		input,
		tag.name === 'tags' && h('small', t('field.tagsHelp')));
}
