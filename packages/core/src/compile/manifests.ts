import { escapeHtml } from '../util/html.ts';
import type { Course } from '../project/model.ts';
import type { DeliveryFormat, Scorm2004Edition } from '../lms/formats.ts';

// The files that say what a package is to its LMS, by format (docs/delivery.md). One SCO, no
// sequencing beyond the simplest: what LMSs take alike. Identifiers derive from the course id only,
// so content updates keep the same structure (what LMSs compare when a package is replaced).

type ManifestCourse = Pick<Course, 'id' | 'title' | 'version' | 'completion'>;

const fileList = (files: Iterable<string>) => [...files].sort().map((file) => `      <file href="${escapeHtml(file)}"/>`).join('\n');

// SCORM 1.2, one SCO, no sequencing: the lowest common denominator of the LMS profiles.
export function scorm12Manifest(course: ManifestCourse, files: Iterable<string>): string {
  const id = course.id;
  const mastery = course.completion?.masteryScore;
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="elabora-${id}" version="${escapeHtml(course.version)}"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org-${id}">
    <organization identifier="org-${id}">
      <title>${escapeHtml(course.title)}</title>
      <item identifier="item-${id}" identifierref="res-${id}" isvisible="true">
        <title>${escapeHtml(course.title)}</title>${mastery !== undefined ? `\n        <adlcp:masteryscore>${mastery}</adlcp:masteryscore>` : ''}
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-${id}" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileList(files)}
    </resource>
  </resources>
</manifest>
`;
}

// SCORM 2004, one SCO. The only sequencing is the item's delivery controls: the content sets the
// completion and the success itself (without them, an LMS may mark the activity completed when the
// window closes). The passing score is the player's (it reports the success): no objective in the
// manifest for LMSs to recompute it from the score, as Moodle does in SCORM 1.2.
export function scorm2004Manifest(course: ManifestCourse, files: Iterable<string>, edition: Scorm2004Edition = '4th'): string {
  const id = course.id;
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="elabora-${id}" version="${escapeHtml(course.version)}"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 ${edition === '3rd' ? '3rd' : '4th'} Edition</schemaversion>
  </metadata>
  <organizations default="org-${id}">
    <organization identifier="org-${id}">
      <title>${escapeHtml(course.title)}</title>
      <item identifier="item-${id}" identifierref="res-${id}" isvisible="true">
        <title>${escapeHtml(course.title)}</title>
        <imsss:sequencing>
          <imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/>
        </imsss:sequencing>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-${id}" type="webcontent" adlcp:scormType="sco" href="index.html">
${fileList(files)}
    </resource>
  </resources>
</manifest>
`;
}

export interface ManifestOptions {
  edition?: Scorm2004Edition;
}

// The files a package of this format adds at its root, by name.
export function packageManifests(format: DeliveryFormat, course: ManifestCourse, files: Iterable<string>, { edition }: ManifestOptions = {}): Map<string, string> {
  if (format === 'scorm2004') return new Map([['imsmanifest.xml', scorm2004Manifest(course, files, edition)]]);
  return new Map([['imsmanifest.xml', scorm12Manifest(course, files)]]);
}

// What LMSs compare on update: the format, identifiers, launch resource, mastery score. Another
// format is another course for an LMS: learners in progress lose their place.
export interface StructureFingerprint {
  format: DeliveryFormat;
  edition?: Scorm2004Edition;
  manifestIdentifier: string;
  organization: string;
  items: string[];
  resources: string[];
  launch: string;
  masteryScore: number | null;
}

export function structureFingerprint(course: Pick<Course, 'id' | 'completion'>, format: DeliveryFormat = 'scorm12', edition?: Scorm2004Edition): StructureFingerprint {
  return {
    format,
    ...(format === 'scorm2004' ? { edition: edition ?? '4th' } : {}),
    manifestIdentifier: `elabora-${course.id}`,
    organization: `org-${course.id}`,
    items: [`item-${course.id}`],
    resources: [`res-${course.id}`],
    launch: 'index.html',
    masteryScore: course.completion?.masteryScore ?? null
  };
}
