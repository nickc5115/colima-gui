'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  system: {
    openExternal: (url) => ipcRenderer.invoke('system:openExternal', url),
  },
  colima: {
    list: () => ipcRenderer.invoke('colima:list'),
    start: (profile) => ipcRenderer.invoke('colima:start', profile),
    stop: (profile) => ipcRenderer.invoke('colima:stop', profile),
    setProfile: (profile) => ipcRenderer.invoke('colima:setProfile', profile),
    logs: (profile) => ipcRenderer.invoke('colima:logs', profile),
    onStartLog: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('colima:startlog', handler);
      return () => ipcRenderer.removeListener('colima:startlog', handler);
    },
  },
  docker: {
    containers: () => ipcRenderer.invoke('docker:containers'),
    images: () => ipcRenderer.invoke('docker:images'),
  },
  container: {
    start: (id) => ipcRenderer.invoke('container:start', id),
    stop: (id) => ipcRenderer.invoke('container:stop', id),
    restart: (id) => ipcRenderer.invoke('container:restart', id),
    remove: (id, force) => ipcRenderer.invoke('container:remove', id, force),
    inspect: (id) => ipcRenderer.invoke('container:inspect', id),
    stats: (id) => ipcRenderer.invoke('container:stats', id),
  },
  exec: {
    start: (id, shell, size) => ipcRenderer.invoke('exec:start', id, shell, size),
    write: (data) => ipcRenderer.invoke('exec:write', data),
    resize: (cols, rows) => ipcRenderer.invoke('exec:resize', cols, rows),
    stop: () => ipcRenderer.invoke('exec:stop'),
    onData: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('exec:data', handler);
      return () => ipcRenderer.removeListener('exec:data', handler);
    },
    onEnd: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('exec:end', handler);
      return () => ipcRenderer.removeListener('exec:end', handler);
    },
  },
  image: {
    remove: (id, force) => ipcRenderer.invoke('image:remove', id, force),
    prune: () => ipcRenderer.invoke('image:prune'),
    listDangling: () => ipcRenderer.invoke('image:listDangling'),
  },
  volume: {
    list: () => ipcRenderer.invoke('docker:volumes'),
    inspect: (name) => ipcRenderer.invoke('volume:inspect', name),
    remove: (name) => ipcRenderer.invoke('volume:remove', name),
    prune: () => ipcRenderer.invoke('volume:prune'),
    listPrunable: () => ipcRenderer.invoke('volume:listPrunable'),
  },
  network: {
    list: () => ipcRenderer.invoke('docker:networks'),
    inspect: (id) => ipcRenderer.invoke('network:inspect', id),
    remove: (id) => ipcRenderer.invoke('network:remove', id),
    prune: () => ipcRenderer.invoke('network:prune'),
    listPrunable: () => ipcRenderer.invoke('network:listPrunable'),
  },
  logs: {
    start: (id) => ipcRenderer.invoke('logs:start', id),
    stop: () => ipcRenderer.invoke('logs:stop'),
    onData: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('logs:data', handler);
      return () => ipcRenderer.removeListener('logs:data', handler);
    },
    onEnd: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('logs:end', handler);
      return () => ipcRenderer.removeListener('logs:end', handler);
    },
    startCompose: (services) => ipcRenderer.invoke('logs:startCompose', services),
    stopCompose: () => ipcRenderer.invoke('logs:stopCompose'),
    onComposeData: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('logs:composeData', handler);
      return () => ipcRenderer.removeListener('logs:composeData', handler);
    },
    onComposeEnd: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('logs:composeEnd', handler);
      return () => ipcRenderer.removeListener('logs:composeEnd', handler);
    },
  },
  config: {
    read: (profile) => ipcRenderer.invoke('config:read', profile),
    write: (profile, content) => ipcRenderer.invoke('config:write', profile, content),
  },
  events: {
    start: () => ipcRenderer.invoke('events:start'),
    stop: () => ipcRenderer.invoke('events:stop'),
    onData: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('events:data', handler);
      return () => ipcRenderer.removeListener('events:data', handler);
    },
    onEnd: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('events:end', handler);
      return () => ipcRenderer.removeListener('events:end', handler);
    },
  },
});
