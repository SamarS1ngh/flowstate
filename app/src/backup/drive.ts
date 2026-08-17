// Google Drive backup/restore of the analysis DB (vibes.db) to the user's OWN
// Drive, in the hidden per-app `appDataFolder` (invisible in their Drive UI,
// can't touch their real files). Auth is Google Sign-In with the non-sensitive
// `drive.appdata` scope -- the same "app identity + per-user consent" model
// WhatsApp uses. The app holds ONE OAuth client id (below); each user's tap-to-
// consent mints a token for THEIR account, so their backup lands in THEIR Drive.
import {NativeModules} from 'react-native';
import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {DB_FILENAME, importVibesDb} from '../db/vibesDb';

// Native AlarmManager scheduler (BackupSchedulerModule.kt): fires a HeadlessJS
// task ('flowstateBackup') at ~2 AM daily to run backupNow() unattended.
const BackupScheduler = (NativeModules as {BackupScheduler?: unknown}).BackupScheduler as
  | {
      schedule: () => Promise<boolean>;
      cancel: () => Promise<boolean>;
      isScheduled: () => Promise<boolean>;
    }
  | undefined;

// The Web application OAuth client id (Google Cloud console). Not a secret --
// it only identifies the app; access to any Drive still requires that user's
// on-device consent. An Android OAuth client (package com.flowstate + the
// release SHA-1) must also exist in the same project for on-device sign-in.
const WEB_CLIENT_ID =
  '354443419488-hr42a8jv36kpmr8bv93n8tt2lhntccua.apps.googleusercontent.com';
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const BACKUP_NAME = 'vibes.db';
const BOUNDARY = 'flowstate_boundary_a7Rk9Ls0Zx';

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    scopes: [DRIVE_APPDATA_SCOPE],
    // We only need an access token for Drive REST, not a server auth code.
    offlineAccess: false,
  });
  configured = true;
}

export class DriveCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'DriveCancelled';
  }
}

/** The signed-in Google account's email, or null if not connected. */
export async function connectedEmail(): Promise<string | null> {
  ensureConfigured();
  try {
    const user = GoogleSignin.getCurrentUser();
    return user?.user.email ?? null;
  } catch {
    return null;
  }
}

/** Prompt the user to connect their Google account (with the Drive scope). */
export async function connectDrive(): Promise<string> {
  ensureConfigured();
  await GoogleSignin.hasPlayServices({showPlayServicesUpdateDialog: true});
  try {
    const res = await GoogleSignin.signIn();
    // google-signin v13+ returns a discriminated result; older returns the user.
    const email =
      (res as {data?: {user?: {email?: string}}}).data?.user?.email ??
      (res as {user?: {email?: string}}).user?.email ??
      (await connectedEmail());
    if (!email) throw new DriveCancelled();
    return email;
  } catch (e) {
    if ((e as {code?: string})?.code === statusCodes.SIGN_IN_CANCELLED) {
      throw new DriveCancelled();
    }
    throw e;
  }
}

export async function disconnectDrive(): Promise<void> {
  ensureConfigured();
  try {
    await GoogleSignin.signOut();
  } catch {
    // already signed out
  }
}

// A fresh access token, signing in silently first if a previous session exists.
async function accessToken(): Promise<string> {
  ensureConfigured();
  if (!GoogleSignin.getCurrentUser()) {
    try {
      await GoogleSignin.signInSilently();
    } catch {
      // no prior session -> caller must connectDrive() first
    }
  }
  const {accessToken: token} = await GoogleSignin.getTokens();
  if (!token) throw new Error('Not connected to Google Drive');
  return token;
}

export interface DriveBackupInfo {
  id: string;
  modifiedTime: string; // RFC3339
  size?: number;
}

/** The existing backup in appDataFolder, or null. */
export async function findBackup(): Promise<DriveBackupInfo | null> {
  const token = await accessToken();
  const url =
    'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder' +
    '&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc';
  const res = await fetch(url, {headers: {Authorization: `Bearer ${token}`}});
  if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
  const json = (await res.json()) as {
    files?: Array<{id: string; name: string; modifiedTime: string; size?: string}>;
  };
  const file = (json.files ?? []).find(f => f.name === BACKUP_NAME) ?? null;
  if (!file) return null;
  return {id: file.id, modifiedTime: file.modifiedTime, size: file.size ? Number(file.size) : undefined};
}

/** Upload the current vibes.db to appDataFolder, replacing any prior backup. */
export async function backupNow(): Promise<DriveBackupInfo> {
  const token = await accessToken();
  const src = `${RNFS.DocumentDirectoryPath}/${DB_FILENAME}`;
  if (!(await RNFS.exists(src))) {
    throw new Error('No analysis data yet — analyze some songs first.');
  }
  const base64 = await RNFS.readFile(src, 'base64');

  const existing = await findBackup();
  // Drive accepts a base64-encoded media part in a multipart/related upload, so
  // the whole request body is plain text (no binary-in-JS-string trouble).
  const metadata = existing ? {name: BACKUP_NAME} : {name: BACKUP_NAME, parents: ['appDataFolder']};
  const body =
    `--${BOUNDARY}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${BOUNDARY}\r\n` +
    'Content-Type: application/octet-stream\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    `${base64}\r\n` +
    `--${BOUNDARY}--`;

  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,modifiedTime,size`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime,size';
  const res = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${BOUNDARY}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive upload failed (${res.status}) ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {id: string; modifiedTime: string; size?: string};
  return {id: json.id, modifiedTime: json.modifiedTime, size: json.size ? Number(json.size) : undefined};
}

/**
 * Download the Drive backup and import it, REPLACING the local analysis DB.
 * Returns false if there's no backup to restore.
 */
export async function restoreFromDrive(): Promise<boolean> {
  const token = await accessToken();
  const backup = await findBackup();
  if (!backup) return false;
  const dest = `${RNFS.DocumentDirectoryPath}/drive-restore.db`;
  if (await RNFS.exists(dest)) await RNFS.unlink(dest);
  const {promise} = RNFS.downloadFile({
    fromUrl: `https://www.googleapis.com/drive/v3/files/${backup.id}?alt=media`,
    toFile: dest,
    headers: {Authorization: `Bearer ${token}`},
  });
  const dl = await promise;
  if (dl.statusCode !== 200) {
    throw new Error(`Drive download failed (${dl.statusCode})`);
  }
  await importVibesDb(dest); // validates + swaps in the DB, reopens
  try {
    await RNFS.unlink(dest);
  } catch {
    // temp cleanup best-effort
  }
  return true;
}

// ── Nightly auto-backup (2 AM) ────────────────────────────────────────────────

/**
 * The HeadlessJS entry point the native AlarmManager fires at ~2 AM. Runs a
 * silent backup; best-effort (a failure just means the next night retries).
 * backupNow() signs in silently from the persisted session, so no UI is needed.
 */
export async function runNightlyBackup(): Promise<void> {
  try {
    await backupNow();
  } catch (e) {
    console.log('[backup] nightly backup failed:', e instanceof Error ? e.message : String(e));
  }
}

export async function enableNightlyBackup(): Promise<void> {
  await BackupScheduler?.schedule();
}

export async function disableNightlyBackup(): Promise<void> {
  await BackupScheduler?.cancel();
}

export async function isNightlyBackupOn(): Promise<boolean> {
  try {
    return (await BackupScheduler?.isScheduled()) ?? false;
  } catch {
    return false;
  }
}
