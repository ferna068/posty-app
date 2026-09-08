import { describe, expect, it } from 'vitest';
import { createPublishService } from '../src/posts/publishService.js';
import { PublishRequestSchema } from '../src/posts/publishRequest.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { PublishError } from '../src/providers/errors.js';
import type { SocialProvider } from '../src/providers/types.js';

function fakeProvider<N extends 'twitter' | 'linkedin' | 'facebook'>(
  id: N,
  impl: () => Promise<{ externalPostId: string; permalink: string | null; publishedAt: string }>,
): SocialProvider<N> {
  return { id, capabilities: { maxTextLength: 99999 }, publishText: impl } as SocialProvider<N>;
}

const baseRequest = {
  text: 'Publicando en tres redes desde Posty.',
  targets: {
    twitter: { accessToken: 't' },
    linkedin: { accessToken: 'l', authorUrn: 'urn:li:person:x' },
    facebook: { pageId: '1', pageAccessToken: 'p' },
  },
};

describe('createPublishService — fan-out con Promise.allSettled', () => {
  it('todas ok -> outcome completed y estado individual por red', async () => {
    const registry = createProviderRegistry({
      twitter: fakeProvider('twitter', async () => ({ externalPostId: 'tw1', permalink: 'https://x/1', publishedAt: 'now' })),
      linkedin: fakeProvider('linkedin', async () => ({ externalPostId: 'li1', permalink: null, publishedAt: 'now' })),
      facebook: fakeProvider('facebook', async () => ({ externalPostId: 'fb1', permalink: 'https://fb/1', publishedAt: 'now' })),
    });
    const request = PublishRequestSchema.parse(baseRequest);
    const res = await createPublishService(registry).publish(request, { requestId: 'r' });

    expect(res.summary.outcome).toBe('completed');
    expect(res.results.twitter).toMatchObject({ status: 'ok', id: 'tw1' });
    expect(res.results.linkedin).toMatchObject({ status: 'ok', id: 'li1', permalink: null });
    expect(res.results.facebook).toMatchObject({ status: 'ok', id: 'fb1' });
  });

  it('un fallo aislado -> outcome partial, las demás publican', async () => {
    const registry = createProviderRegistry({
      twitter: fakeProvider('twitter', async () => ({ externalPostId: 'tw1', permalink: null, publishedAt: 'now' })),
      linkedin: fakeProvider('linkedin', async () => {
        throw new PublishError({ network: 'linkedin', code: 'REAUTH_REQUIRED', message: 'Reconecta LinkedIn.' });
      }),
      facebook: fakeProvider('facebook', async () => ({ externalPostId: 'fb1', permalink: null, publishedAt: 'now' })),
    });
    const request = PublishRequestSchema.parse(baseRequest);
    const res = await createPublishService(registry).publish(request, { requestId: 'r' });

    expect(res.summary.outcome).toBe('partial');
    expect(res.summary.ok).toEqual(['twitter', 'facebook']);
    expect(res.summary.failed).toEqual(['linkedin']);
    expect(res.results.linkedin).toEqual({
      status: 'failed',
      reason: 'Reconecta LinkedIn.',
      code: 'REAUTH_REQUIRED',
      retryable: false,
    });
  });

  it('todas fallan -> outcome failed', async () => {
    const boom = async () => {
      throw new PublishError({ network: 'twitter', code: 'PROVIDER_UNAVAILABLE', message: 'caída' });
    };
    const registry = createProviderRegistry({
      twitter: fakeProvider('twitter', boom),
      linkedin: fakeProvider('linkedin', boom),
      facebook: fakeProvider('facebook', boom),
    });
    const request = PublishRequestSchema.parse({ text: 'x', targets: baseRequest.targets });
    const res = await createPublishService(registry).publish(request, { requestId: 'r' });
    expect(res.summary.outcome).toBe('failed');
  });

  it('una excepción no-PublishError no tumba el fan-out', async () => {
    const registry = createProviderRegistry({
      twitter: fakeProvider('twitter', async () => ({ externalPostId: 'tw1', permalink: null, publishedAt: 'now' })),
      linkedin: fakeProvider('linkedin', async () => {
        throw new Error('bug inesperado');
      }),
      facebook: fakeProvider('facebook', async () => ({ externalPostId: 'fb1', permalink: null, publishedAt: 'now' })),
    });
    const request = PublishRequestSchema.parse(baseRequest);
    const res = await createPublishService(registry).publish(request, { requestId: 'r' });
    expect(res.summary.outcome).toBe('partial');
    expect(res.results.linkedin).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
  });

  it('solo publica en las redes con credenciales', async () => {
    const registry = createProviderRegistry({
      twitter: fakeProvider('twitter', async () => ({ externalPostId: 'tw1', permalink: null, publishedAt: 'now' })),
    });
    const request = PublishRequestSchema.parse({ text: 'solo x', targets: { twitter: { accessToken: 't' } } });
    const res = await createPublishService(registry).publish(request, { requestId: 'r' });
    expect(Object.keys(res.results)).toEqual(['twitter']);
  });
});

describe('PublishRequestSchema', () => {
  it('exige al menos una red', () => {
    expect(PublishRequestSchema.safeParse({ text: 'x', targets: {} }).success).toBe(false);
  });

  it('rechaza authorUrn con formato inválido', () => {
    const parsed = PublishRequestSchema.safeParse({
      text: 'x',
      targets: { linkedin: { accessToken: 'l', authorUrn: 'abc' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('rechaza claves desconocidas en targets', () => {
    const parsed = PublishRequestSchema.safeParse({
      text: 'x',
      targets: { mastodon: { accessToken: 'm' } },
    });
    expect(parsed.success).toBe(false);
  });
});
