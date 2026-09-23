import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, maskApiKey, settingsInputSchema, type SettingsInput } from '@turtle/shared';

export type StoredSettings = SettingsInput & { apiKey: string };

export class SettingsStore {
  readonly file: string;
  private value: StoredSettings;
  private loadWarning = '';

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
    } catch (error) {
      const backup = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { copyFileSync(this.file, backup); } catch { /* The original remains untouched if backup itself fails. */ }
      this.loadWarning = `设置文件无法解析，已保留损坏副本：${backup}。${error instanceof Error ? error.message : ''}`;
      return { ...DEFAULT_SETTINGS, apiKey: '' };
    }
  }

  public getDiagnostic(): { ok: boolean; warning: string; file: string } { return { ok: !this.loadWarning, warning: this.loadWarning, file: this.file }; }

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
    const descriptor = openSync(temp, 'r+');
    try { fsyncSync(descriptor); } catch { /* Some Windows/network filesystems reject fsync; atomic rename still preserves the previous file. */ } finally { closeSync(descriptor); }
    renameSync(temp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* Windows ACLs remain inherited from the current user profile. */ }
    const verified = JSON.parse(readFileSync(this.file, 'utf8')) as StoredSettings;
    if (verified.apiKey !== this.value.apiKey) throw new Error('设置文件写入后校验失败，未报告保存成功');
  }
}
