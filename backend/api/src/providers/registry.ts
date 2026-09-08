import { FacebookProvider } from './facebook.js';
import { LinkedInProvider } from './linkedin.js';
import { TwitterProvider } from './twitter.js';
import type { NetworkId, SocialProvider } from './types.js';

/**
 * Registro `NetworkId -> SocialProvider` (ARCHITECTURE.md §1.3 / carpeta `providers/registry.ts`).
 * Único punto de resolución: el servicio de publicación nunca instancia adaptadores.
 */
export interface ProviderRegistry {
  get<N extends NetworkId>(id: N): SocialProvider<N>;
}

export function createProviderRegistry(overrides?: Partial<{
  twitter: SocialProvider<'twitter'>;
  linkedin: SocialProvider<'linkedin'>;
  facebook: SocialProvider<'facebook'>;
}>): ProviderRegistry {
  const providers = {
    twitter: overrides?.twitter ?? new TwitterProvider(),
    linkedin: overrides?.linkedin ?? new LinkedInProvider(),
    facebook: overrides?.facebook ?? new FacebookProvider(),
  } satisfies Record<NetworkId, SocialProvider>;

  return {
    get<N extends NetworkId>(id: N): SocialProvider<N> {
      return providers[id] as SocialProvider<N>;
    },
  };
}
