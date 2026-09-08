import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacebookProvider, appsecretProof } from '../src/providers/facebook.js';
import { LinkedInProvider, escapeCommentary } from '../src/providers/linkedin.js';
import { TwitterProvider, weightedLength } from '../src/providers/twitter.js';
import { PublishError } from '../src/providers/errors.js';
import { stubFetch } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TwitterProvider', () => {
  const creds = { accessToken: 'tw-token' };

  it('publica y normaliza id + permalink', async () => {
    const { calls } = stubFetch([{ status: 201, body: { data: { id: '1832994210022338560', text: 'hola' } } }]);
    const result = await new TwitterProvider().publishText({ text: 'hola', credentials: creds, requestId: 'r1' });

    expect(result.externalPostId).toBe('1832994210022338560');
    expect(result.permalink).toContain('1832994210022338560');
    expect(calls[0]!.url).toBe('https://api.twitter.com/2/tweets');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tw-token');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ text: 'hola' });
  });

  it('rechaza texto que supera la longitud ponderada sin llamar a la API', async () => {
    stubFetch([]);
    await expect(
      new TwitterProvider().publishText({ text: '国'.repeat(141), credentials: creds, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
  });

  it('mapea 403 duplicate -> DUPLICATE_CONTENT', async () => {
    stubFetch([{ status: 403, body: { detail: 'You are not allowed to create a Tweet with duplicate content.' } }]);
    await expect(
      new TwitterProvider().publishText({ text: 'x', credentials: creds, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_CONTENT', retryable: false });
  });

  it('mapea 429 con x-rate-limit-reset -> RATE_LIMITED retryable', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    stubFetch([{ status: 429, headers: { 'x-rate-limit-reset': String(reset) }, body: { title: 'Too Many Requests' } }]);
    const err = await new TwitterProvider()
      .publishText({ text: 'x', credentials: creds, requestId: 'r' })
      .catch((e) => e as PublishError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('timeout de transporte -> PROVIDER_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    await expect(
      new TwitterProvider().publishText({ text: 'x', credentials: creds, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });
});

describe('LinkedInProvider', () => {
  const creds = { accessToken: 'li-token', authorUrn: 'urn:li:person:abc' };

  it('publica con headers de versión y lee x-restli-id', async () => {
    const { calls } = stubFetch([
      { status: 201, headers: { 'x-restli-id': 'urn:li:share:7231884019922330112' }, body: {} },
    ]);
    const result = await new LinkedInProvider().publishText({ text: 'hola (mundo)', credentials: creds, requestId: 'r' });

    expect(result.externalPostId).toBe('urn:li:share:7231884019922330112');
    expect(calls[0]!.headers['linkedin-version']).toMatch(/^\d{6}$/);
    expect(calls[0]!.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(JSON.parse(calls[0]!.body!).commentary).toBe('hola \\(mundo\\)');
  });

  it('mapea 401 -> REAUTH_REQUIRED', async () => {
    stubFetch([{ status: 401, body: { serviceErrorCode: 65600, message: 'Invalid access token' } }]);
    await expect(
      new LinkedInProvider().publishText({ text: 'x', credentials: creds, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED', retryable: false });
  });
});

describe('FacebookProvider', () => {
  const creds = { pageId: '123', pageAccessToken: 'pg-token' };

  it('publica en /feed como form-urlencoded', async () => {
    const { calls } = stubFetch([{ status: 200, body: { id: '123_456' } }]);
    const result = await new FacebookProvider().publishText({ text: 'hola', credentials: creds, requestId: 'r' });

    expect(result.externalPostId).toBe('123_456');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/123/feed');
    expect(calls[0]!.headers['content-type']).toContain('application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[0]!.body!);
    expect(form.get('message')).toBe('hola');
    expect(form.get('access_token')).toBe('pg-token');
  });

  it('mapea OAuthException code 190 -> REAUTH_REQUIRED', async () => {
    stubFetch([{ status: 400, body: { error: { type: 'OAuthException', code: 190, message: 'expired' } } }]);
    await expect(
      new FacebookProvider().publishText({ text: 'x', credentials: creds, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });

  it('mapea code 4 -> RATE_LIMITED', async () => {
    stubFetch([{ status: 403, body: { error: { code: 4, message: 'App request limit reached' } } }]);
    await expect(
      new FacebookProvider().publishText({ text: 'x', credentials: creds, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });
});

describe('helpers puros', () => {
  it('weightedLength cuenta CJK doble', () => {
    expect(weightedLength('abc')).toBe(3);
    expect(weightedLength('国国')).toBe(4);
  });

  it('escapeCommentary escapa caracteres reservados', () => {
    expect(escapeCommentary('a (b) [c] #d')).toBe('a \\(b\\) \\[c\\] \\#d');
  });

  it('appsecretProof es HMAC-SHA256 hex estable', () => {
    expect(appsecretProof('token', 'secret')).toMatch(/^[a-f0-9]{64}$/);
    expect(appsecretProof('token', 'secret')).toBe(appsecretProof('token', 'secret'));
  });
});
