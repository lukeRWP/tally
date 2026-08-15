/**
 * Coerce an API list field to an array.
 *
 * A page renders `items.map(...)`, and if the server sends a shape the client
 * did not expect — an object where a list was promised, a null, an error body
 * that still parsed — that call throws inside render. React unmounts the tree
 * and the whole screen becomes "Something went wrong", including the parts
 * that had nothing to do with the bad response.
 *
 * This turns that into an empty list: the page still draws, the other sections
 * still work, and the user sees "nothing here" rather than a dead screen. That
 * is a better failure, not a hidden one — the request itself still reports its
 * own error state through TanStack Query, which is what the retry UI reads.
 *
 * Observed for real: /print crashed with "(x ?? []).filter is not a function"
 * against an endpoint whose payload was one level off.
 */
export function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
