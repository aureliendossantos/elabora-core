// The course's activity in cmi5 and xAPI: course.json delivery.activityId (an IRI the client owns),
// else urn:elabora:course:<id>. The compiler's cmi5.xml and tincan.xml and the player's statements
// say the same; it never changes with the version, so an LRS adds every version's statements up.
export const activityIdOf = (course: { id: string; lms?: { activityId?: string }; delivery?: { activityId?: string } }): string => course.lms?.activityId ?? course.delivery?.activityId ?? `urn:elabora:course:${course.id}`;
