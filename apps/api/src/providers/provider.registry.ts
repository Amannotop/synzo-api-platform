import type { AppConfig } from '@synzo/config';
import type { AIProvider } from './provider.interface.js';
import { OpenCodeProvider } from './opencode.provider.js';

/**
 * The trusted provider registry (§32).
 *
 * The upstream is chosen strictly server-side by provider NAME resolved from
 * the models table. A customer can never supply a URL, host or path that
 * influences where the server sends a request, so SSRF via the API surface is
 * structurally impossible rather than filtered.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  constructor(config: AppConfig) {
    // Only OpenCode is implemented. Additional providers are added here as
    // concrete classes; nothing else in the codebase needs to change.
    this.register(new OpenCodeProvider(config));
  }

  register(provider: AIProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  getOrThrow(name: string): AIProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`No provider registered for "${name}"`);
    }
    return provider;
  }

  list(): AIProvider[] {
    return [...this.providers.values()];
  }
}
