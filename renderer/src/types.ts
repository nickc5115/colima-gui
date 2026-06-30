export type Tab = 'containers' | 'images' | 'volumes' | 'compose' | 'networks';
export type ThemePref = 'system' | 'dark' | 'light';
export type ActionName = 'start' | 'stop' | 'restart';

export type ApiResult<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };

export interface ColimaProfile {
  name: string;
  status: string;
  cpus?: number;
  memory?: number;
  runtime?: string;
}

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string[];
  composeProject: string | null;
  composeService: string | null;
  composeWorkdir: string | null;
}

export interface ImageSummary {
  id: string;
  tags: string[];
  size: number;
  created: number;
}

export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  created: string;
  labels: Record<string, string>;
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  ipam: string;
  containerCount: number | null;
  builtin: boolean;
}

export interface StatsSnapshot {
  cpu: number;
  cpuCount: number;
  memUsage: number;
  memLimit: number;
  warming: boolean;
}

export interface LogData {
  id: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

export interface LogEnd {
  id?: string;
  running?: boolean;
  error?: string;
}

export interface ComposeServiceRef {
  id: string;
  service: string;
}

export interface ComposeLogData {
  service: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

export interface ComposeLogEnd {
  service: string;
  id?: string;
  running?: boolean;
  error?: string;
}

export interface DockerEvent {
  Type?: string;
  Action?: string;
  status?: string;
  id?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
}

export interface ColimaConfigRead {
  raw: string;
  parsed: Record<string, any>;
  path: string;
}

export interface WindowApi {
  colima: {
    list: () => Promise<ApiResult<{ profiles: ColimaProfile[] }>>;
    start: (profile: string) => Promise<ApiResult>;
    stop: (profile: string) => Promise<ApiResult>;
    setProfile: (profile: string) => Promise<ApiResult<{ profile: string }>>;
    logs: (profile: string) => Promise<ApiResult<{ text: string; path: string }>>;
    onStartLog: (cb: (payload: string) => void) => () => void;
  };
  docker: {
    containers: () => Promise<ApiResult<{ containers: ContainerSummary[] }>>;
    images: () => Promise<ApiResult<{ images: ImageSummary[] }>>;
  };
  container: {
    start: (id: string) => Promise<ApiResult>;
    stop: (id: string) => Promise<ApiResult>;
    restart: (id: string) => Promise<ApiResult>;
    remove: (id: string, force: boolean) => Promise<ApiResult>;
    inspect: (id: string) => Promise<ApiResult<{ info: any }>>;
    stats: (id: string) => Promise<ApiResult<StatsSnapshot>>;
  };
  exec: {
    start: (id: string, shell: string, size: { cols: number; rows: number }) => Promise<ApiResult>;
    write: (data: string) => Promise<ApiResult>;
    resize: (cols: number, rows: number) => Promise<ApiResult>;
    stop: () => Promise<ApiResult>;
    onData: (cb: (payload: string) => void) => () => void;
    onEnd: (cb: (payload: { error?: string }) => void) => () => void;
  };
  image: {
    remove: (id: string, force: boolean) => Promise<ApiResult>;
    prune: () => Promise<ApiResult<{ reclaimed: number; deleted: number }>>;
    listDangling: () => Promise<ApiResult<{ images: Array<{ id: string; size: number; created: number }> }>>;
  };
  volume: {
    list: () => Promise<ApiResult<{ volumes: VolumeSummary[] }>>;
    inspect: (name: string) => Promise<ApiResult<{ info: any }>>;
    remove: (name: string) => Promise<ApiResult>;
    prune: () => Promise<ApiResult<{ reclaimed: number; count: number }>>;
    listPrunable: () => Promise<ApiResult<{ volumes: Array<{ name: string; driver: string }> }>>;
  };
  network: {
    list: () => Promise<ApiResult<{ networks: NetworkSummary[] }>>;
    inspect: (id: string) => Promise<ApiResult<{ info: any }>>;
    remove: (id: string) => Promise<ApiResult>;
    prune: () => Promise<ApiResult<{ count: number }>>;
    listPrunable: () => Promise<ApiResult<{ networks: Array<{ id: string; name: string; driver: string }> }>>;
  };
  logs: {
    start: (id: string) => Promise<ApiResult>;
    stop: () => Promise<ApiResult>;
    onData: (cb: (payload: LogData) => void) => () => void;
    onEnd: (cb: (payload: LogEnd) => void) => () => void;
    startCompose: (services: ComposeServiceRef[]) => Promise<ApiResult>;
    stopCompose: () => Promise<ApiResult>;
    onComposeData: (cb: (payload: ComposeLogData) => void) => () => void;
    onComposeEnd: (cb: (payload: ComposeLogEnd) => void) => () => void;
  };
  config: {
    read: (profile: string) => Promise<ApiResult<ColimaConfigRead>>;
    write: (profile: string, content: string | Record<string, any>) => Promise<ApiResult>;
  };
  events: {
    start: () => Promise<ApiResult>;
    stop: () => Promise<ApiResult>;
    onData: (cb: (payload: DockerEvent) => void) => () => void;
    onEnd: (cb: (payload: { error?: string }) => void) => () => void;
  };
}

declare global {
  interface Window {
    api: WindowApi;
  }
}
