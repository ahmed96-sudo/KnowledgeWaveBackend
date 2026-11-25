import type { Localized } from "../lib/localized.js";
import { normalize } from "../lib/search.js";

/**
 * The two stored search columns of a course. EVERY place that creates or edits a course (seed, instructor builder,
 * admin) must write the result of this function; test/catalog.test.ts fails if any stored value drifts.
 *  - searchText: what the course-list text filter matches (the frontend's `title en + ar + tags`)
 *  - searchMeta: what /search also looks at (tags, subtitle, instructor name)
 */
export function courseSearchColumns(
  c: { title: Localized; subtitle: Localized; tags: string[] },
  instructorName: Localized,
) {
  return {
    searchText: normalize(`${c.title.en} ${c.title.ar} ${c.tags.join(" ")}`),
    searchMeta: normalize(`${c.tags.join(" ")} ${c.subtitle.en} ${c.subtitle.ar} ${instructorName.en} ${instructorName.ar}`),
  };
}
