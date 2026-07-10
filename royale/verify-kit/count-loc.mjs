#!/usr/bin/env node
/**
 * Signals Royale LOC metrics (RULES.md "Objectives, ranked" 1 and 2).
 *
 * Two independent measurements, either or both per invocation:
 *
 * Fork LOC (objective 1):
 *   git diff --numstat <base>..<head> -- packages/  inside a React checkout,
 *   insertions + deletions summed, rows whose path contains "__tests__"
 *   excluded. Raw diff lines are what count; keep the checkout formatted
 *   with React's own prettier before measuring.
 *
 * Library LOC (objective 2):
 *   For each package dir: every .ts/.tsx under src/, excluding declaration
 *   files, test/spec files, and any path segment named tests/adapters/
 *   tools/docs (and singular forms). Each file is normalized with prettier
 *   (printWidth 100) so formatting style cannot move the score, then
 *   non-blank, non-comment lines are counted. Comments are free by rule —
 *   stripping documentation never improves the number.
 *
 * Usage:
 *   node count-loc.mjs --fork <reactCheckout> --base <sha> [--head <ref>] \
 *                      --lib <pkgDir> [--lib <pkgDir> ...]
 * Output: JSON { forkLoc, libLoc, perFile } on stdout.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const opts = { fork: undefined, base: undefined, head: 'HEAD', libs: [] }
for (let i = 0; i < args.length; i++) {
	const a = args[i]
	if (a === '--fork') {
		opts.fork = args[++i]
	} else if (a === '--base') {
		opts.base = args[++i]
	} else if (a === '--head') {
		opts.head = args[++i]
	} else if (a === '--lib') {
		opts.libs.push(args[++i])
	} else {
		console.error(`unknown argument: ${a}`)
		process.exit(2)
	}
}
if (opts.fork === undefined && opts.libs.length === 0) {
	console.error('nothing to do: pass --fork <checkout> --base <sha> and/or --lib <pkgDir>')
	process.exit(2)
}

// ---- fork metric -----------------------------------------------------------------

function countFork(checkout, base, head) {
	const out = execFileSync(
		'git',
		['-C', checkout, 'diff', '--numstat', `${base}..${head}`, '--', 'packages/'],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
	)
	let total = 0
	const perFile = {}
	for (const line of out.split('\n')) {
		if (line.trim() === '') {
			continue
		}
		const [adds, dels, ...pathParts] = line.split('\t')
		const path = pathParts.join('\t')
		if (adds === '-' || dels === '-') {
			continue
		} // binary
		if (path.includes('__tests__')) {
			continue
		} // test files are free
		const n = Number(adds) + Number(dels)
		total += n
		perFile[path] = n
	}
	return { total, perFile }
}

// ---- library metric --------------------------------------------------------------

// Path segments that mark non-product code inside src/ (tests, adapters,
// tools, docs are excluded from the score by rule; debug/ and *.debug.ts
// are debug tooling — the incumbents' stated 4700/5000 baselines exclude
// them). Required-feature code (e.g. the causality tracer) hidden under an
// excluded segment is a scoring dodge — recount by hand if review finds it.
const EXCLUDED_SEGMENTS = /^(tests?|__tests__|adapters?|tools?|docs?|debug)$/i
const EXCLUDED_FILE = /(\.d\.ts|\.test\.tsx?|\.spec\.tsx?|\.debug\.tsx?)$/

function listSourceFiles(dir) {
	const out = []
	for (const name of readdirSync(dir)) {
		const full = join(dir, name)
		const st = statSync(full)
		if (st.isDirectory()) {
			if (EXCLUDED_SEGMENTS.test(name)) {
				continue
			}
			out.push(...listSourceFiles(full))
		} else if (/\.tsx?$/.test(name) && !EXCLUDED_FILE.test(name)) {
			out.push(full)
		}
	}
	return out
}

async function loadPrettier() {
	// Prefer a prettier already installed near this repo (the React checkout
	// carries 3.x); fall back to any resolvable install from cwd.
	const here = dirname(fileURLToPath(import.meta.url))
	const candidates = [
		join(here, '..', '..', 'vendor', 'react', 'package.json'),
		join(process.cwd(), 'package.json'),
		join(here, 'package.json'),
	]
	for (const from of candidates) {
		if (!existsSync(from)) {
			continue
		}
		try {
			const req = createRequire(from)
			const entry = req.resolve('prettier')
			return await import(pathToFileURL(entry).href)
		} catch {
			/* try next */
		}
	}
	throw new Error('prettier not resolvable; run `npm i -g prettier` or run from a repo that has it')
}

/**
 * Count non-blank, non-comment lines. The scanner tracks strings, template
 * literals (with ${} nesting), regex literals, and both comment forms, so a
 * "//" inside a string or regex never truncates a line. Comment text is
 * replaced with spaces (line structure preserved), then blank lines drop.
 */
function countCodeLines(src) {
	const n = src.length
	const out = []
	let i = 0
	// What the previous significant character allows: a `/` after a value
	// (identifier, literal close) is division; elsewhere it starts a regex.
	let prevSignificant = ''
	const templateDepth = [] // ${} nesting per open template literal
	let inTemplate = false
	while (i < n) {
		const c = src[i]
		const c2 = src[i + 1]
		if (c === '/' && c2 === '/') {
			while (i < n && src[i] !== '\n') {
				out.push(' ')
				i++
			}
			continue
		}
		if (c === '/' && c2 === '*') {
			out.push(' ', ' ')
			i += 2
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
				out.push(src[i] === '\n' ? '\n' : ' ')
				i++
			}
			if (i < n) {
				out.push(' ', ' ')
				i += 2
			}
			continue
		}
		if (c === '"' || c === "'") {
			out.push(c)
			i++
			while (i < n && src[i] !== c) {
				if (src[i] === '\\') {
					out.push(src[i], src[i + 1] ?? '')
					i += 2
					continue
				}
				out.push(src[i])
				i++
			}
			if (i < n) {
				out.push(c)
				i++
			}
			prevSignificant = c
			continue
		}
		if (c === '`' || (inTemplate && c === '}' && templateDepth[templateDepth.length - 1] === 0)) {
			// Enter (or re-enter after ${expr}) a template literal body.
			if (c === '`') {
				templateDepth.push(0)
			} else {
				templateDepth[templateDepth.length - 1] = -1
			} // consumed the closing }
			out.push(c)
			i++
			let closed = false
			while (i < n && !closed) {
				if (src[i] === '\\') {
					out.push(src[i], src[i + 1] ?? '')
					i += 2
					continue
				}
				if (src[i] === '`') {
					out.push('`')
					i++
					closed = true
					break
				}
				if (src[i] === '$' && src[i + 1] === '{') {
					out.push('$', '{')
					i += 2
					templateDepth[templateDepth.length - 1] = 0
					break // back to code scanning inside ${}
				}
				out.push(src[i] === '\n' ? '\n' : src[i])
				i++
			}
			if (closed) {
				templateDepth.pop()
			}
			inTemplate = templateDepth.length > 0
			prevSignificant = '`'
			continue
		}
		if (c === '{' && inTemplate) {
			templateDepth[templateDepth.length - 1]++
		}
		if (c === '}' && inTemplate) {
			templateDepth[templateDepth.length - 1]--
		}
		if (c === '/' && !/[\w)\]$'"`]/.test(prevSignificant)) {
			// Regex literal: skip to the unescaped closing /, honoring classes.
			out.push('/')
			i++
			let inClass = false
			while (i < n) {
				if (src[i] === '\\') {
					out.push(src[i], src[i + 1] ?? '')
					i += 2
					continue
				}
				if (src[i] === '[') {
					inClass = true
				}
				if (src[i] === ']') {
					inClass = false
				}
				out.push(src[i])
				if (src[i] === '/' && !inClass) {
					i++
					break
				}
				i++
			}
			prevSignificant = '/'
			continue
		}
		out.push(c)
		if (!/\s/.test(c)) {
			prevSignificant = c
		}
		i++
	}
	return out
		.join('')
		.split('\n')
		.filter((line) => line.trim() !== '').length
}

async function countLib(pkgDirs) {
	const prettier = await loadPrettier()
	const format = prettier.format ?? prettier.default.format
	let total = 0
	const perFile = {}
	for (const pkg of pkgDirs) {
		const srcDir = join(resolve(pkg), 'src')
		if (!existsSync(srcDir)) {
			console.error(`warning: ${pkg} has no src/ directory; skipped`)
			continue
		}
		for (const file of listSourceFiles(srcDir)) {
			const raw = readFileSync(file, 'utf8')
			const formatted = await format(raw, { parser: 'typescript', printWidth: 100 })
			const lines = countCodeLines(formatted)
			total += lines
			perFile[file.split(sep).slice(-4).join('/')] = lines
		}
	}
	return { total, perFile }
}

// ---- main ------------------------------------------------------------------------

const result = { forkLoc: null, libLoc: null, perFile: {} }
if (opts.fork !== undefined) {
	if (opts.base === undefined) {
		console.error('--fork requires --base <sha>')
		process.exit(2)
	}
	const fork = countFork(resolve(opts.fork), opts.base, opts.head)
	result.forkLoc = fork.total
	Object.assign(result.perFile, fork.perFile)
}
if (opts.libs.length > 0) {
	const lib = await countLib(opts.libs)
	result.libLoc = lib.total
	Object.assign(result.perFile, lib.perFile)
}
console.log(JSON.stringify(result, null, 2))
