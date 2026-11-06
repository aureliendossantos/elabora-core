import { escapeHtml } from '../util/html.ts';
import { activityIdOf } from '@elabora/player/activity-id';
import type { Course } from '../project/model.ts';

// The files that describe an xAPI package to its LMS: cmi5.xml (cmi5, docs/delivery-cmi5.md) and
// tincan.xml (xAPI alone, docs/delivery-xapi.md). One activity, the course, launched from index.html.

type ManifestCourse = Pick<Course, 'id' | 'title' | 'description' | 'language' | 'completion'> & { delivery?: { activityId?: string } };

// The course's activity: course.json delivery.activityId (an IRI the client owns), else
// urn:elabora:course:<id>, as the player says it (@elabora/player activity-id.ts). It never changes with the
// version: statements of every version add up.
export { activityIdOf };

// cmi5's moveOn from the course's completion rule: completed when the course reports completion,
// passed when it reports success (the mastery score as the AU's masteryScore, 0 to 1).
export function cmi5MoveOn(course: Pick<ManifestCourse, 'completion'>): { moveOn: 'Completed' | 'Passed'; masteryScore?: number } {
  const reportAs = course.completion?.reportAs ?? 'completed-incomplete';
  const mastery = course.completion?.masteryScore;
  if (reportAs.startsWith('passed')) return { moveOn: 'Passed', ...(mastery !== undefined ? { masteryScore: mastery / 100 } : {}) };
  return { moveOn: 'Completed' };
}

const lang = (course: ManifestCourse) => escapeHtml(course.language || 'en');

// cmi5.xml (Quartz, CourseStructure.xsd): one course and one AU. launchMethod AnyWindow: the LMS opens
// it where it wants (360Learning asks for it in a popup).
export function cmi5Manifest(course: ManifestCourse): string {
  const id = activityIdOf(course);
  const { moveOn, masteryScore } = cmi5MoveOn(course);
  const description = course.description?.trim() || course.title;
  const texts = (text: string) => `<langstring lang="${lang(course)}">${escapeHtml(text)}</langstring>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="${escapeHtml(id)}">
    <title>${texts(course.title)}</title>
    <description>${texts(description)}</description>
  </course>
  <au id="${escapeHtml(`${id}/au`)}" moveOn="${moveOn}"${masteryScore !== undefined ? ` masteryScore="${masteryScore}"` : ''} launchMethod="AnyWindow">
    <title>${texts(course.title)}</title>
    <description>${texts(description)}</description>
    <url>index.html</url>
  </au>
</courseStructure>
`;
}

// tincan.xml: the activity the LMS launches (Tin Can launch), its name, description and launch file.
export function tincanManifest(course: ManifestCourse): string {
  const description = course.description?.trim() || course.title;
  return `<?xml version="1.0" encoding="utf-8"?>
<tincan xmlns="http://projecttincan.com/tincan.xsd">
  <activities>
    <activity id="${escapeHtml(activityIdOf(course))}" type="http://adlnet.gov/expapi/activities/course">
      <name lang="${lang(course)}">${escapeHtml(course.title)}</name>
      <description lang="${lang(course)}">${escapeHtml(description)}</description>
      <launch lang="${lang(course)}">index.html</launch>
    </activity>
  </activities>
</tincan>
`;
}
