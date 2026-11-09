// Visitor OS / CPU guess for the "앱 내려받기" screen. The OS comes from the user agent; the CPU only
// from User-Agent Client Hints (Chromium) — Safari/Firefox on a Mac cannot tell Apple chip from Intel,
// so `arch` stays null there and the screen shows both Mac downloads with a hint.
import type { AppArch, AppPlatform } from '@euta-cloud/shared';

export interface VisitorOs {
  platform: AppPlatform | null;
  arch: AppArch | null;
}

export function osFromUserAgent(ua: string): AppPlatform | null {
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return null;
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'win';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

interface UaData {
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
}

export async function detectVisitorOs(): Promise<VisitorOs> {
  const platform = osFromUserAgent(navigator.userAgent);
  let arch: AppArch | null = platform === 'win' || platform === 'linux' ? 'x64' : null;
  const uaData = (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
  if (platform && uaData?.getHighEntropyValues) {
    try {
      const v = await uaData.getHighEntropyValues(['architecture', 'bitness']);
      if (v.architecture === 'arm') arch = 'arm64';
      else if (v.architecture === 'x86') arch = 'x64';
    } catch {
      /* keep the guess */
    }
  }
  return { platform, arch };
}

export const PLATFORM_LABEL: Record<AppPlatform, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

/** "macOS (Apple 칩)" · "Windows (64비트)" · "Linux (x64 · AppImage)" */
export function installerLabel(platform: AppPlatform, arch: AppArch | null): string {
  if (platform === 'mac') return arch === 'x64' ? 'macOS (Intel)' : 'macOS (Apple 칩)';
  if (platform === 'win') return arch === 'arm64' ? 'Windows (ARM 64비트)' : 'Windows (64비트)';
  return arch === 'arm64' ? 'Linux (ARM64 · AppImage)' : 'Linux (x64 · AppImage)';
}
