import { afterEach, describe, expect, it } from 'vitest';

import {
  collectPackCliCommands,
  listPackCliCommands,
  registerPackCliCommands,
  resetPackCliCommands,
} from '../src/host/pack-cli.js';
import { invokePackHttpRoute, registerPackHttpRoutes, resetPackHttpRoutes } from '../src/host/http-routes.js';

afterEach(() => {
  resetPackCliCommands();
  resetPackHttpRoutes();
});

describe('pack cli commands', () => {
  it('registers commands in order and rejects reserved or duplicate names', () => {
    registerPackCliCommands('sample', [{
      name: 'cards',
      summary: 'list cards',
      run: () => 0,
    }]);
    expect(listPackCliCommands().map((command) => command.name)).toEqual(['cards']);
    expect(() => registerPackCliCommands('sample', [])).toThrow(/duplicate registration/);
    expect(() => registerPackCliCommands('other', [{
      name: 'run',
      summary: 'nope',
      run: () => 0,
    }])).toThrow(/reserved/);
    expect(() => collectPackCliCommands([{
      name: 'cards',
      summary: 'again',
      run: () => 0,
    }])).toThrow(/duplicate command/);
  });

  it('keeps extra commands out of the registry', () => {
    const merged = collectPackCliCommands([{
      name: 'ppt',
      summary: 'list slides',
      run: () => 0,
    }]);
    expect(merged.map((command) => command.name)).toEqual(['ppt']);
    expect(listPackCliCommands()).toEqual([]);
  });
});

describe('pack http routes on the in-process router', () => {
  it('returns the handler data and keeps the first registration', async () => {
    registerPackHttpRoutes('demo', [{
      method: 'POST',
      path: '/host/demo/ping',
      handler: async () => ({ ok: true }),
    }]);
    registerPackHttpRoutes('demo', [{
      method: 'POST',
      path: '/host/demo/ping',
      handler: async () => ({ ok: false }),
    }]);
    await expect(invokePackHttpRoute('POST', '/host/demo/ping', {})).resolves.toEqual({
      status: 200,
      data: { ok: true },
    });
    await expect(invokePackHttpRoute('GET', '/host/demo/ping', {})).resolves.toBeNull();
  });
});
