export async function npmVersionExists(name, version) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  )
  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${name}@${version}`)
  }
  return true
}
