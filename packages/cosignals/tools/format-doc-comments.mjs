import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export function formatDocComments(source) {
  let result = ""
  let copiedThrough = 0
  let i = 0

  while (i < source.length) {
    const char = source[i]
    if (char === '"' || char === "'" || char === "`") {
      const quote = char
      i += 1
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2
        } else if (source[i] === quote) {
          i += 1
          break
        } else {
          i += 1
        }
      }
      continue
    }
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i + 2)
      i = newline === -1 ? source.length : newline + 1
      continue
    }
    if (!source.startsWith("/*", i)) {
      i += 1
      continue
    }

    const end = source.indexOf("*/", i + 2)
    if (end === -1) {
      break
    }
    const commentEnd = end + 2
    const comment = source.slice(i, commentEnd)
    const lineStart = source.lastIndexOf("\n", i - 1) + 1
    const indent = source.slice(lineStart, i)
    if (
      comment.startsWith("/**") &&
      (comment.includes("\n") || comment.includes("\r")) &&
      /^[\t ]*$/.test(indent)
    ) {
      const newline = comment.includes("\r\n") ? "\r\n" : "\n"
      const lines = comment.split(/\r?\n/)
      const content = []
      let first = lines[0].slice(3)
      if (first.startsWith(" ")) {
        first = first.slice(1)
      }
      first = first.trimEnd()
      if (first !== "") {
        content.push(first)
      }
      for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
        let line = lines[lineIndex]
        if (lineIndex === lines.length - 1) {
          line = line.slice(0, -2)
        }
        line = line.replace(/^[\t ]*\*/, "")
        if (line.startsWith(" ")) {
          line = line.slice(1)
        }
        line = line.trimEnd()
        if (lineIndex < lines.length - 1 || line !== "") {
          content.push(line)
        }
      }
      const body = content.map((line) => `${indent} *${line === "" ? "" : ` ${line}`}`)
      const formatted = ["/**", ...body, `${indent} */`].join(newline)
      if (formatted !== comment) {
        result += source.slice(copiedThrough, i) + formatted
        copiedThrough = commentEnd
      }
    }
    i = commentEnd
  }

  return result + source.slice(copiedThrough)
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const files = process.argv.slice(2)
  if (files.length === 0 || files[0] === "--help") {
    console.log("Usage: format-doc-comments <file>...")
    process.exitCode = files.length === 0 ? 1 : 0
  } else {
    for (const file of files) {
      const source = await readFile(file, "utf8")
      const formatted = formatDocComments(source)
      if (formatted !== source) {
        await writeFile(file, formatted)
        console.log(file)
      }
    }
  }
}
