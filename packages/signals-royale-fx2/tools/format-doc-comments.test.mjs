import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDocComments } from './format-doc-comments.mjs'

test('expands multiline doc comments and leaves one-line comments alone', () => {
	const source = [
		'/** One component-owned signal effect, as built by the factory passed to',
		' * useSignalEffect or useSignalLayoutEffect. Which hook runs the factory',
		' * decides the schedule; everything else is described per field. */',
		'export interface Effect {}',
		'',
		'\t/** One line */',
		'\tconst value = `',
		'/** This is template content, not a doc comment.',
		' * Leave it alone. */',
		'`',
	].join('\n')

	assert.equal(
		formatDocComments(source),
		[
			'/**',
			' * One component-owned signal effect, as built by the factory passed to',
			' * useSignalEffect or useSignalLayoutEffect. Which hook runs the factory',
			' * decides the schedule; everything else is described per field.',
			' */',
			'export interface Effect {}',
			'',
			'\t/** One line */',
			'\tconst value = `',
			'/** This is template content, not a doc comment.',
			' * Leave it alone. */',
			'`',
		].join('\n'),
	)
})

test('preserves indentation, blank lines, CRLF, and canonical comments', () => {
	const source = [
		'\t/** First paragraph.',
		'\t *',
		'\t * Second paragraph. */',
		'\t/**',
		'\t * Already formatted.',
		'\t */',
	].join('\r\n')

	assert.equal(
		formatDocComments(source),
		[
			'\t/**',
			'\t * First paragraph.',
			'\t *',
			'\t * Second paragraph.',
			'\t */',
			'\t/**',
			'\t * Already formatted.',
			'\t */',
		].join('\r\n'),
	)
})
