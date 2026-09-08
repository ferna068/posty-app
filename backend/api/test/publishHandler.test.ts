import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { createPublishService } from '../src/posts/publishService.js';
import { PublishError } from '../src/providers/errors.js';
import type { SocialProvider } from '../src/providers/types.js';
import type { Server } from 'node:http';

function fakeProvider<N extends 'twitter' | 'linkedin' | 'facebook'>(id: N, impl: SocialProvider<N>['publishText']) {
  return { id, capabilities: { maxTextLength: 99999 }, publishText: impl } as SocialProvider<N>;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const registry = createProviderRegistry({
    twitter: fakeProvider('twitter', async () => ({ externalPostId: 'tw1', permalink: 'https://x/1', publishedAt: 'now' })),
    linkedin: fakeProvider('linkedin', async () => {
      throw new PublishError({ network: 'linkedin', code: 'REAUTH_REQUIRED', message: 'Reconecta LinkedIn.' });
    }),
    facebook: fakeProvider('facebook', async () => ({ externalPostId: 'fb1', permalink: null, publishedAt: 'now' })),
  });
  const app = createApp({ publishService: createPublishService(registry) });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

describe('POST /api/v1/posts/publish', () => {
  it('422 cuando el cuerpo no cumple el esquema', async () => {
    const res = await fetch(`${baseUrl}/api/v1/posts/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('207 con estado individual por red en fallo parcial', async () => {
    const res = await fetch(`${baseUrl}/api/v1/posts/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hola',
        targets: {
          twitter: { accessToken: 't' },
          linkedin: { accessToken: 'l', authorUrn: 'urn:li:person:x' },
          facebook: { pageId: '1', pageAccessToken: 'p' },
        },
      }),
    });
    expect(res.status).toBe(207);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const { data } = await res.json();
    expect(data.summary.outcome).toBe('partial');
    expect(data.results.twitter.status).toBe('ok');
    expect(data.results.linkedin).toMatchObject({ status: 'failed', code: 'REAUTH_REQUIRED' });
    expect(data.results.facebook.status).toBe('ok');
  });

  it('400 cuando el JSON está mal formado', async () => {
    const res = await fetch(`${baseUrl}/api/v1/posts/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });
});
