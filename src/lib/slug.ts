/** Spec §7.1: NFKD, strip diacritics, lower-case, non-alphanumerics -> "-", trim "-", max 60 chars. */
export function slugify(text: string, max = 60) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** slugify(text) (or `fallback` when nothing is left, e.g. Arabic-only), then -2, -3... until `taken` says it is free. */
export async function uniqueSlug(text: string, taken: (slug: string) => Promise<boolean>, fallback: string) {
  const base = slugify(text) || fallback;
  let slug = base;
  for (let n = 2; await taken(slug); n++) slug = `${base}-${n}`;
  return slug;
}
