// App releases (SPEC_앱-배포-업데이트, stage 17): public release list / compat and the admin list.

export type AppPlatform = 'mac' | 'win' | 'linux';
export type AppArch = 'arm64' | 'x64';
export type AppReleaseFileKind = 'installer' | 'update' | 'meta';

/** GET /api/app/releases file entry. `arch` is null for latest*.yml (meta). `url` is absolute. */
export interface AppReleaseFileDto {
  platform: AppPlatform;
  arch: AppArch | null;
  kind: AppReleaseFileKind;
  name: string;
  size: number;
  url: string;
}

export interface AppReleaseDto {
  version: string;
  publishedAt: string;
  notes: string;
  files: AppReleaseFileDto[];
}

/** GET /api/app/releases?channel= — published only, newest first, at most 3. */
export interface AppReleasesDto {
  channel: string;
  releases: AppReleaseDto[];
}

/** GET /api/app/compat */
export interface AppCompatDto {
  minVersion: string | null;
}

/** GET /api/admin/app-releases entry (drafts included). */
export interface AdminAppReleaseDto {
  version: string;
  channel: string;
  status: 'draft' | 'published';
  notes: string;
  createdAt: string;
  publishedAt: string | null;
  files: { name: string; size: number; sha512: string; platform: AppPlatform; arch: AppArch | null; kind: AppReleaseFileKind }[];
}

/** GitHub release mirror run outcome (ADR-048 decision 2). */
export type AppMirrorResult = 'published' | 'already' | 'none' | 'error';

/** Mirror status (`APP_MIRROR_GITHUB` set) — in GET /api/admin/app-releases `mirror` and POST …/mirror. */
export interface AppMirrorStatusDto {
  /** `<owner>/<repo>` on GitHub. */
  repo: string;
  /** A sync run is in progress. */
  running: boolean;
  /** null → no run yet since the server started. */
  lastRun: { at: string; result: AppMirrorResult; version?: string; message?: string } | null;
}

/** GET /api/admin/app-releases */
export interface AdminAppReleasesDto {
  releases: AdminAppReleaseDto[];
  /** null → mirroring is off. */
  mirror: AppMirrorStatusDto | null;
}
