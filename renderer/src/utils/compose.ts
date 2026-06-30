import type { ContainerSummary } from '../types';

export function groupComposeProjects(containers: ContainerSummary[]): Map<string, ContainerSummary[]> {
  const projects = new Map<string, ContainerSummary[]>();
  for (const c of containers) {
    if (!c.composeProject) continue;
    if (!projects.has(c.composeProject)) projects.set(c.composeProject, []);
    projects.get(c.composeProject)!.push(c);
  }
  for (const services of projects.values()) {
    services.sort((a, b) => (a.composeService || '').localeCompare(b.composeService || ''));
  }
  return new Map([...projects.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}
