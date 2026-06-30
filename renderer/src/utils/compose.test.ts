import { describe, expect, it } from 'vitest';
import { groupComposeProjects } from './compose';
import type { ContainerSummary } from '../types';

function c(name: string, project: string | null, service: string | null): ContainerSummary {
  return { id: name, name, image: 'img', state: 'running', status: 'Up', ports: [], composeProject: project, composeService: service, composeWorkdir: null };
}

describe('groupComposeProjects', () => {
  it('groups compose containers and ignores non-compose containers', () => {
    const grouped = groupComposeProjects([c('a', 'p1', 'web'), c('b', null, null), c('c', 'p1', 'api')]);
    expect([...grouped.keys()]).toEqual(['p1']);
    expect(grouped.get('p1')!.map((x) => x.composeService)).toEqual(['api', 'web']);
  });
});
