/**
 * Keychain utilities for storing and retrieving Proton credentials
 */

// @ts-expect-error - keychain doesn't have type definitions
import keychain from 'keychain';
import { promisify } from 'util';

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT = 'proton-drive-sync:tokens';

const keychainGetPassword = promisify(keychain.getPassword).bind(keychain);
const keychainSetPassword = promisify(keychain.setPassword).bind(keychain);
const keychainDeletePassword = promisify(keychain.deletePassword).bind(keychain);

/** Tokens stored in keychain for session reuse */
export interface StoredCredentials {
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  SaltedKeyPass?: string;
  username: string;
}

export async function getStoredCredentials(): Promise<StoredCredentials | null> {
  try {
    const data = await keychainGetPassword({
      account: KEYCHAIN_ACCOUNT,
      service: KEYCHAIN_SERVICE,
    });
    return JSON.parse(data) as StoredCredentials;
  } catch {
    return null;
  }
}

export async function storeCredentials(credentials: StoredCredentials): Promise<void> {
  await keychainSetPassword({
    account: KEYCHAIN_ACCOUNT,
    service: KEYCHAIN_SERVICE,
    password: JSON.stringify(credentials),
  });
}

export async function deleteStoredCredentials(): Promise<void> {
  try {
    await keychainDeletePassword({
      account: KEYCHAIN_ACCOUNT,
      service: KEYCHAIN_SERVICE,
    });
  } catch {
    // Ignore - may not exist
  }
}
