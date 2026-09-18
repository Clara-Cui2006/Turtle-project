import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, maskApiKey, settingsInputSchema, type SettingsInput } from '@turtle/shared';

export type StoredSettings = SettingsInput & { apiKey: string };

export class SettingsStore {
  readonly file: string;
  private value: StoredSettings;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'local-settings.json');
    this.value = this.load();
  }

  private load(): StoredSettings {
    if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS, apiKey: '' };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredSettings>;
      const safe = settingsInputSchema.parse({ ...DEFAULT_SETTINGS, ...parsed, apiKey: undefined });
      return { ...safe, apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '' };
    } catch {
      return { ...DEFAULT_SETTINGS, apiKey: '' };
    }
  }

  public getPrivate(): StoredSettings { return { ...this.value }; }
  public getPublic() {
    const { apiKey, ...settings } = this.value;
    return { ...settings, apiKeyConfigured: Boolean(apiKey), maskedApiKey: maskApiKey(apiKey) };
  }

  public save(input: unknown): ReturnType<SettingsStore['getPublic']> {
    const candidate = settingsInputSchema.parse(input);
    this.value = { ...candidate, apiKey: candidate.apiKey?.trim() || this.value.apiKey };
    this.persist();
    return this.getPublic();
  }

  public clearKey(): void { this.value.apiKey = ''; this.persist(); }

  private persist(): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.value, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* Windows ACLs remain inherited from the current user profile. */ }
  }
}
