import { escapeHtml } from '../util/html.ts';
import type { Course } from '../project/model.ts';

// SCORM 1.2, one SCO, no sequencing: the lowest common denominator of the LMS profiles.
// Identifiers derive from the course id only, so content updates keep the same manifest
// structure (what LMSs compare when a package is replaced).
export function scorm12Manifest(course: Pick<Course, 'id' | 'title' | 'version' | 'completion'>, files: Iterable<string>): string {
  const id = course.id;
  const mastery = course.completion?.masteryScore;
  const fileList = [...files].sort().map((file) => `      <file href="${escapeHtml(file)}"/>`).join('\n');
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
${fileList}
    </resource>
  </resources>
</manifest>
`;
}

// What LMSs compare on update: identifiers, launch resource, SCORM version, mastery score.
export interface StructureFingerprint {
  scormVersion: '1.2';
  manifestIdentifier: string;
  organization: string;
  items: string[];
  resources: string[];
  launch: string;
  masteryScore: number | null;
}

export function structureFingerprint(course: Pick<Course, 'id' | 'completion'>): StructureFingerprint {
  return {
    scormVersion: '1.2',
    manifestIdentifier: `elabora-${course.id}`,
    organization: `org-${course.id}`,
    items: [`item-${course.id}`],
    resources: [`res-${course.id}`],
    launch: 'index.html',
    masteryScore: course.completion?.masteryScore ?? null
  };
}
