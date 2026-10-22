/**
 * Department identity: four colors per theme, cycled in department order and
 * always shown beside the department name. `--dept-n-band` fills the
 * department head and `--dept-n-card` the module header; each theme decides
 * how loud they are.
 */
export function departmentTone(departmentIndex: number): number {
  return (((departmentIndex % 4) + 4) % 4) + 1;
}
