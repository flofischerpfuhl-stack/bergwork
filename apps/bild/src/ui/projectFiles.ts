/** Project archives: `.fwimg`, and `.zip` as written by earlier builds. Shared by every drop target. */
const PROJECT_FILE = /\.(fwimg|zip)$/i;

export function isProjectFile(name: string): boolean {
  return PROJECT_FILE.test(name);
}
