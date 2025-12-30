#!/usr/bin/env node

/**
 * Proton Drive Authentication Module
 *
 * Implements Proton SRP (Secure Remote Password) authentication compatible with
 * the Proton API, including:
 * - SRP authentication with bcrypt password hashing
 * - 2FA/TOTP support
 * - Session persistence (UID, AccessToken, RefreshToken, SaltedKeyPass)
 * - Key decryption using key password derived from bcrypt
 *
 * Based on the rclone protondrive backend authentication flow.
 */

import * as openpgp from 'openpgp';
import bcrypt from 'bcryptjs';
import { logger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

interface AuthInfo {
  Version: number;
  Modulus: string;
  ServerEphemeral: string;
  Salt: string;
  SRPSession?: string;
}

interface Credentials {
  password: string;
}

interface SrpProofs {
  clientEphemeral: Uint8Array;
  clientProof: Uint8Array;
  expectedServerProof: Uint8Array;
  sharedSession: Uint8Array;
}

interface SrpResult {
  clientEphemeral: string;
  clientProof: string;
  expectedServerProof: string;
}

interface AddressKeyInfo {
  ID: string;
  Primary: number;
  armoredKey: string;
  passphrase: string;
}

interface AddressData {
  ID: string;
  Email: string;
  Type: number;
  Status: number;
  keys: AddressKeyInfo[];
}

interface Session {
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  UserID?: string;
  Scope?: string;
  user?: User;
  keyPassword?: string;
  primaryKey?: openpgp.PrivateKey;
  addresses?: AddressData[];
  password?: string;
}

interface User {
  ID: string;
  Name: string;
  Keys?: UserKey[];
}

interface UserKey {
  ID: string;
  PrivateKey: string;
}

interface KeySalt {
  ID: string;
  KeySalt: string;
}

interface Address {
  ID: string;
  Email: string;
  Type: number;
  Status: number;
  Keys?: AddressKeyData[];
}

interface AddressKeyData {
  ID: string;
  Primary: number;
  PrivateKey: string;
  Token?: string;
}

interface ApiError extends Error {
  code?: number;
  status?: number;
  response?: ApiResponse;
  requires2FA?: boolean;
  twoFAInfo?: TwoFAInfo;
}

interface ApiResponse {
  Code: number;
  Error?: string;
  [key: string]: unknown;
}

interface TwoFAInfo {
  Enabled: number;
  [key: string]: unknown;
}

interface AuthResponse extends ApiResponse {
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  UserID: string;
  Scope: string;
  ServerProof: string;
  '2FA'?: TwoFAInfo;
}

interface ReusableCredentials {
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  SaltedKeyPass?: string;
}

// ============================================================================
// Constants
// ============================================================================

const API_BASE_URL = 'https://api.protonmail.ch';
const SRP_LEN = 256; // 2048 / 8, in bytes
const AUTH_VERSION = 4;
const BCRYPT_PREFIX = '$2y$10$';
const PLATFORM =
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
const APP_VERSION = `${PLATFORM}-drive@1.0.0-alpha.1`;

// SRP Modulus verification key
const SRP_MODULUS_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

xjMEXAHLgxYJKwYBBAHaRw8BAQdAFurWXXwjTemqjD7CXjXVyKf0of7n9Ctm
L8v9enkzggHNEnByb3RvbkBzcnAubW9kdWx1c8J3BBAWCgApBQJcAcuDBgsJ
BwgDAgkQNQWFxOlRjyYEFQgKAgMWAgECGQECGwMCHgEAAPGRAP9sauJsW12U
MnTQUZpsbJb53d0Wv55mZIIiJL2XulpWPQD/V6NglBd96lZKBmInSXX/kXat
Sv+y0io+LR8i2+jV+AbOOARcAcuDEgorBgEEAZdVAQUBAQdAeJHUz1c9+KfE
kSIgcBRE3WuXC4oj5a2/U3oASExGDW4DAQgHwmEEGBYIABMFAlwBy4MJEDUF
hcTpUY8mAhsMAAD/XQD8DxNI6E78meodQI+wLsrKLeHn32iLvUqJbVDhfWSU
WO4BAMcm1u02t4VKw++ttECPt+HUgPUq5pqQWe5Q2cW4TMsE
=Y4Mw
-----END PGP PUBLIC KEY BLOCK-----`;

// ============================================================================
// BigInt Utilities
// ============================================================================

/**
 * Convert Uint8Array to BigInt (little-endian)
 */
function uint8ArrayToBigIntLE(arr: Uint8Array): bigint {
  let result = 0n;
  for (let i = arr.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(arr[arr.length - 1 - i]);
  }
  return result;
}

/**
 * Convert BigInt to Uint8Array (little-endian)
 */
function bigIntToUint8ArrayLE(num: bigint, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let temp = num;
  for (let i = 0; i < length; i++) {
    result[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return result;
}

/**
 * Get byte length of a BigInt
 */
function bigIntByteLength(num: bigint): number {
  if (num === 0n) return 1;
  let length = 0;
  let temp = num;
  while (temp > 0n) {
    temp >>= 8n;
    length++;
  }
  return length;
}

/**
 * Modular exponentiation: (base^exp) mod modulus
 */
function modExp(base: bigint, exp: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  base = base % modulus;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % modulus;
    }
    exp = exp >> 1n;
    base = (base * base) % modulus;
  }
  return result;
}

/**
 * Modulo operation that handles negative numbers correctly
 */
function mod(n: bigint, m: bigint): bigint {
  return ((n % m) + m) % m;
}

// ============================================================================
// Crypto Utilities
// ============================================================================

/**
 * Compute SHA-512 hash
 */
async function sha512(data: Uint8Array): Promise<Uint8Array> {
  // Create a new ArrayBuffer copy to satisfy TypeScript's strict typing
  const buffer = await crypto.subtle.digest('SHA-512', new Uint8Array(data));
  return new Uint8Array(buffer);
}

/**
 * Expand hash using SHA-512 (concatenating 4 hashes with indices)
 */
async function expandHash(input: Uint8Array): Promise<Uint8Array> {
  const hashes = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const combined = new Uint8Array(input.length + 1);
      combined.set(input);
      combined[input.length] = i;
      return sha512(combined);
    })
  );
  const result = new Uint8Array(hashes.reduce((acc, h) => acc + h.length, 0));
  let offset = 0;
  for (const hash of hashes) {
    result.set(hash, offset);
    offset += hash.length;
  }
  return result;
}

/**
 * Base64 encode Uint8Array
 */
function base64Encode(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}

/**
 * Base64 decode to Uint8Array
 */
function base64Decode(str: string): Uint8Array {
  const binaryStr = atob(str);
  const arr = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    arr[i] = binaryStr.charCodeAt(i);
  }
  return arr;
}

/**
 * Convert string to Uint8Array (UTF-8 encoding)
 */
function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert binary string to Uint8Array (treats each char as a byte value)
 * This is different from stringToUint8Array which uses UTF-8 encoding
 */
function binaryStringToArray(str: string): Uint8Array {
  const result = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    result[i] = str.charCodeAt(i);
  }
  return result;
}

/**
 * Convert Uint8Array to binary string
 */
function uint8ArrayToBinaryString(arr: Uint8Array): string {
  return String.fromCharCode(...arr);
}

/**
 * Merge multiple Uint8Arrays
 */
function mergeUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ============================================================================
// bcrypt Utilities
// ============================================================================

/**
 * Custom bcrypt base64 encoding (uses ./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789)
 */
function bcryptEncodeBase64(data: Uint8Array, length: number): string {
  const BCRYPT_CHARS = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  let off = 0;
  let c1: number, c2: number;

  while (off < length) {
    c1 = data[off++] & 0xff;
    result += BCRYPT_CHARS[(c1 >> 2) & 0x3f];
    c1 = (c1 & 0x03) << 4;
    if (off >= length) {
      result += BCRYPT_CHARS[c1 & 0x3f];
      break;
    }
    c2 = data[off++] & 0xff;
    c1 |= (c2 >> 4) & 0x0f;
    result += BCRYPT_CHARS[c1 & 0x3f];
    c1 = (c2 & 0x0f) << 2;
    if (off >= length) {
      result += BCRYPT_CHARS[c1 & 0x3f];
      break;
    }
    c2 = data[off++] & 0xff;
    c1 |= (c2 >> 6) & 0x03;
    result += BCRYPT_CHARS[c1 & 0x3f];
    result += BCRYPT_CHARS[c2 & 0x3f];
  }
  return result;
}

// ============================================================================
// Password Hashing
// ============================================================================

interface HashPasswordParams {
  password: string;
  salt?: string;
  modulus: Uint8Array;
  version: number;
}

/**
 * Hash password using bcrypt and expand with SHA-512
 */
async function formatHash(
  password: string,
  salt: string,
  modulus: Uint8Array
): Promise<Uint8Array> {
  const hash = bcrypt.hashSync(password, BCRYPT_PREFIX + salt);
  const hashBytes = stringToUint8Array(hash);
  return expandHash(mergeUint8Arrays([hashBytes, modulus]));
}

/**
 * Hash password for auth version 3+
 */
async function hashPasswordV3(
  password: string,
  salt: string,
  modulus: Uint8Array
): Promise<Uint8Array> {
  // salt is a binary string (from base64 decode), so we must use binaryStringToArray
  // not stringToUint8Array (which would UTF-8 encode and corrupt bytes > 127)
  const saltBinary = binaryStringToArray(salt + 'proton');
  const bcryptSalt = bcryptEncodeBase64(saltBinary, 16);
  return formatHash(password, bcryptSalt, modulus);
}

/**
 * Hash password based on auth version
 */
async function hashPassword({
  password,
  salt,
  modulus,
  version,
}: HashPasswordParams): Promise<Uint8Array> {
  if (version >= 3) {
    if (!salt) throw new Error('Missing salt for auth version >= 3');
    return hashPasswordV3(password, salt, modulus);
  }
  throw new Error(`Unsupported auth version: ${version}`);
}

/**
 * Compute key password from password and salt using bcrypt
 */
async function computeKeyPassword(password: string, salt: string): Promise<string> {
  if (!password || !salt || salt.length !== 24 || password.length < 1) {
    throw new Error('Password and salt required.');
  }
  const saltBinary = base64Decode(salt);
  const bcryptSalt = bcryptEncodeBase64(saltBinary, 16);
  const hash = bcrypt.hashSync(password, BCRYPT_PREFIX + bcryptSalt);
  // Remove bcrypt prefix and salt (first 29 characters)
  return hash.slice(29);
}

// ============================================================================
// SRP Protocol
// ============================================================================

interface GenerateProofsParams {
  byteLength: number;
  modulusArray: Uint8Array;
  hashedPasswordArray: Uint8Array;
  serverEphemeralArray: Uint8Array;
}

/**
 * Verify and extract modulus from signed message
 */
async function verifyAndGetModulus(signedModulus: string): Promise<Uint8Array> {
  // Import the verification key
  const publicKey = await openpgp.readKey({ armoredKey: SRP_MODULUS_KEY });

  // Read and verify the cleartext message
  const message = await openpgp.readCleartextMessage({ cleartextMessage: signedModulus });
  const verificationResult = await openpgp.verify({
    message,
    verificationKeys: publicKey,
  });

  // Check verification status
  const { verified } = verificationResult.signatures[0];
  try {
    await verified;
  } catch {
    throw new Error('Unable to verify server identity');
  }

  // Extract and decode the modulus
  const modulusData = verificationResult.data;
  return base64Decode(modulusData);
}

/**
 * Generate SRP proofs
 */
async function generateProofs({
  byteLength,
  modulusArray,
  hashedPasswordArray,
  serverEphemeralArray,
}: GenerateProofsParams): Promise<SrpProofs> {
  const modulus = uint8ArrayToBigIntLE(modulusArray.slice().reverse());

  if (bigIntByteLength(modulus) !== byteLength) {
    throw new Error('SRP modulus has incorrect size');
  }

  const generator = 2n;
  const generatorArray = bigIntToUint8ArrayLE(generator, byteLength);
  const multiplierHash = await expandHash(mergeUint8Arrays([generatorArray, modulusArray]));
  const multiplier = uint8ArrayToBigIntLE(multiplierHash.slice().reverse());

  const serverEphemeral = uint8ArrayToBigIntLE(serverEphemeralArray.slice().reverse());
  const hashedPassword = uint8ArrayToBigIntLE(hashedPasswordArray.slice().reverse());

  if (serverEphemeral === 0n) {
    throw new Error('SRP server ephemeral is out of bounds');
  }

  const modulusMinusOne = modulus - 1n;
  const multiplierReduced = mod(multiplier, modulus);

  // Generate client secret and ephemeral
  let clientSecret: bigint = 0n;
  let clientEphemeral: bigint = 0n;
  let scramblingParam: bigint = 0n;

  for (let i = 0; i < 1000; i++) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(byteLength));
    clientSecret = uint8ArrayToBigIntLE(randomBytes.slice().reverse());
    clientEphemeral = modExp(generator, clientSecret, modulus);

    const clientEphemeralArray = bigIntToUint8ArrayLE(clientEphemeral, byteLength);
    const clientServerHash = await expandHash(
      mergeUint8Arrays([clientEphemeralArray, serverEphemeralArray])
    );
    scramblingParam = uint8ArrayToBigIntLE(clientServerHash.slice().reverse());

    if (scramblingParam !== 0n && clientEphemeral !== 0n) {
      break;
    }
  }

  // Calculate shared session key
  const kgx = mod(modExp(generator, hashedPassword, modulus) * multiplierReduced, modulus);
  const sharedSessionKeyExponent = mod(
    scramblingParam * hashedPassword + clientSecret,
    modulusMinusOne
  );
  const sharedSessionKeyBase = mod(serverEphemeral - kgx, modulus);
  const sharedSessionKey = modExp(sharedSessionKeyBase, sharedSessionKeyExponent, modulus);

  const clientEphemeralArray = bigIntToUint8ArrayLE(clientEphemeral, byteLength);
  const sharedSessionArray = bigIntToUint8ArrayLE(sharedSessionKey, byteLength);

  // Generate proofs
  const clientProof = await expandHash(
    mergeUint8Arrays([clientEphemeralArray, serverEphemeralArray, sharedSessionArray])
  );
  const expectedServerProof = await expandHash(
    mergeUint8Arrays([clientEphemeralArray, clientProof, sharedSessionArray])
  );

  return {
    clientEphemeral: clientEphemeralArray,
    clientProof,
    expectedServerProof,
    sharedSession: sharedSessionArray,
  };
}

/**
 * Get SRP authentication parameters
 */
async function getSrp(authInfo: AuthInfo, credentials: Credentials): Promise<SrpResult> {
  const { Version, Modulus: serverModulus, ServerEphemeral, Salt } = authInfo;
  const { password } = credentials;

  const modulusArray = await verifyAndGetModulus(serverModulus);
  const serverEphemeralArray = base64Decode(ServerEphemeral);

  const hashedPasswordArray = await hashPassword({
    version: Version,
    password,
    salt: Version >= 3 ? uint8ArrayToBinaryString(base64Decode(Salt)) : undefined,
    modulus: modulusArray,
  });

  const { clientEphemeral, clientProof, expectedServerProof } = await generateProofs({
    byteLength: SRP_LEN,
    modulusArray,
    hashedPasswordArray,
    serverEphemeralArray,
  });

  return {
    clientEphemeral: base64Encode(clientEphemeral),
    clientProof: base64Encode(clientProof),
    expectedServerProof: base64Encode(expectedServerProof),
  };
}

// ============================================================================
// HTTP Client
// ============================================================================

/**
 * Create headers for API requests
 */
function createHeaders(session: Session | null = null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-pm-appversion': APP_VERSION,
  };
  if (session?.UID) {
    headers['x-pm-uid'] = session.UID;
  }
  if (session?.AccessToken) {
    headers['Authorization'] = `Bearer ${session.AccessToken}`;
  }
  return headers;
}

/**
 * Make API request
 */
async function apiRequest<T extends ApiResponse>(
  method: string,
  endpoint: string,
  data: Record<string, unknown> | null = null,
  session: Session | null = null
): Promise<T> {
  const url = `${API_BASE_URL}/${endpoint}`;
  const options: RequestInit = {
    method,
    headers: createHeaders(session),
  };
  if (data) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);
  const json = (await response.json()) as T;

  if (!response.ok || json.Code !== 1000) {
    const error = new Error(json.Error || `API error: ${response.status}`) as ApiError;
    error.code = json.Code;
    error.response = json;
    error.status = response.status;
    throw error;
  }

  return json;
}

// ============================================================================
// ProtonAuth Class
// ============================================================================

/**
 * Proton authentication handler
 *
 * Usage:
 * ```
 * const auth = new ProtonAuth();
 * const session = await auth.login(username, password);
 *
 * // If 2FA is required:
 * if (session.requires2FA) {
 *     await auth.submit2FA(code);
 * }
 *
 * // Get session info
 * const { UID, AccessToken, RefreshToken, keyPassword, addresses } = auth.getSession();
 *
 * // Logout
 * await auth.logout();
 * ```
 */
export class ProtonAuth {
  private session: Session | null = null;
  private pendingAuthResponse: AuthResponse | null = null;

  /**
   * Make an API request with automatic token refresh on 401
   */
  private async apiRequestWithRefresh<T extends ApiResponse>(
    method: string,
    endpoint: string,
    data: Record<string, unknown> | null = null
  ): Promise<T> {
    if (!this.session) {
      throw new Error('No session available');
    }

    try {
      return await apiRequest<T>(method, endpoint, data, this.session);
    } catch (error) {
      const apiError = error as ApiError;
      // Handle expired access token (401) - try to refresh and retry
      if (apiError.status === 401 && this.session?.RefreshToken) {
        logger.info('Access token expired, attempting refresh...');
        await this.refreshToken();
        // Retry with new token
        return await apiRequest<T>(method, endpoint, data, this.session);
      }
      throw error;
    }
  }

  /**
   * Authenticate with username and password
   */
  async login(
    username: string,
    password: string,
    twoFactorCode: string | null = null
  ): Promise<Session> {
    // Get auth info
    const authInfo = await apiRequest<AuthInfo & ApiResponse>('POST', 'core/v4/auth/info', {
      Username: username,
    });

    // Generate SRP proofs
    const { clientEphemeral, clientProof, expectedServerProof } = await getSrp(authInfo, {
      password,
    });

    // Authenticate
    const authData: Record<string, unknown> = {
      Username: username,
      ClientEphemeral: clientEphemeral,
      ClientProof: clientProof,
      SRPSession: authInfo.SRPSession,
      PersistentCookies: 0,
    };

    if (twoFactorCode) {
      authData.TwoFactorCode = twoFactorCode;
    }

    const authResponse = await apiRequest<AuthResponse>('POST', 'core/v4/auth', authData);

    // Verify server proof
    if (authResponse.ServerProof !== expectedServerProof) {
      throw new Error('Server proof verification failed');
    }

    // Check if 2FA is required
    if (authResponse['2FA']?.Enabled && !twoFactorCode) {
      this.pendingAuthResponse = authResponse;
      this.session = {
        UID: authResponse.UID,
        AccessToken: authResponse.AccessToken,
        RefreshToken: authResponse.RefreshToken,
      };

      const error = new Error('2FA required') as ApiError;
      error.requires2FA = true;
      error.twoFAInfo = authResponse['2FA'];
      // Store password for use after 2FA
      this.session.password = password;
      throw error;
    }

    // Store session
    this.session = {
      UID: authResponse.UID,
      AccessToken: authResponse.AccessToken,
      RefreshToken: authResponse.RefreshToken,
      UserID: authResponse.UserID,
      Scope: authResponse.Scope,
    };

    // Fetch user data and keys
    await this._fetchUserAndKeys(password);

    return this.session;
  }

  /**
   * Submit 2FA code
   */
  async submit2FA(code: string): Promise<Session> {
    if (!this.session?.UID) {
      throw new Error('No pending 2FA authentication');
    }

    const response = await apiRequest<
      ApiResponse & { AccessToken?: string; RefreshToken?: string }
    >('POST', 'core/v4/auth/2fa', { TwoFactorCode: code }, this.session);

    // Update session with new tokens if provided
    if (response.AccessToken) {
      this.session.AccessToken = response.AccessToken;
    }
    if (response.RefreshToken) {
      this.session.RefreshToken = response.RefreshToken;
    }

    // Now fetch user data and decrypt keys (this was deferred during login due to 2FA)
    if (this.session.password) {
      await this._fetchUserAndKeys(this.session.password);
    }

    return this.session;
  }

  /**
   * Fetch user data after successful authentication
   */
  async fetchUserData(): Promise<void> {
    if (!this.session?.password) {
      throw new Error('Password not available for key decryption');
    }
    // This is called after 2FA to complete the session setup
    // The password should have been stored during initial login attempt
  }

  /**
   * Fetch user information and decrypt keys
   */
  private async _fetchUserAndKeys(password: string): Promise<void> {
    if (!this.session) {
      throw new Error('No session available');
    }

    // Fetch user info
    const userResponse = await apiRequest<ApiResponse & { User: User }>(
      'GET',
      'core/v4/users',
      null,
      this.session
    );
    this.session.user = userResponse.User;

    // Fetch key salts
    const saltsResponse = await apiRequest<ApiResponse & { KeySalts?: KeySalt[] }>(
      'GET',
      'core/v4/keys/salts',
      null,
      this.session
    );
    const keySalts = saltsResponse.KeySalts || [];

    // Fetch addresses
    const addressesResponse = await apiRequest<ApiResponse & { Addresses?: Address[] }>(
      'GET',
      'core/v4/addresses',
      null,
      this.session
    );
    const addresses = addressesResponse.Addresses || [];

    // Find primary key and its salt
    const primaryKey = this.session.user?.Keys?.[0];
    if (primaryKey) {
      const keySalt = keySalts.find((s) => s.ID === primaryKey.ID);

      if (keySalt?.KeySalt) {
        // Compute key password from password and salt
        const keyPassword = await computeKeyPassword(password, keySalt.KeySalt);
        this.session.keyPassword = keyPassword;

        // Try to decrypt the primary key
        try {
          const privateKey = await openpgp.readPrivateKey({
            armoredKey: primaryKey.PrivateKey,
          });
          const decryptedKey = await openpgp.decryptKey({
            privateKey,
            passphrase: keyPassword,
          });
          this.session.primaryKey = decryptedKey;
        } catch (error) {
          logger.warn('Failed to decrypt primary key:', (error as Error).message);
        }
      }
    }

    // Process addresses and their keys
    this.session.addresses = [];
    for (const address of addresses) {
      const addressData: AddressData = {
        ID: address.ID,
        Email: address.Email,
        Type: address.Type,
        Status: address.Status,
        keys: [],
      };

      for (const key of address.Keys || []) {
        const keySalt = keySalts.find((s) => s.ID === key.ID);

        try {
          let addressKeyPassword: string | undefined;

          // If the key has a Token, decrypt it using the user's primary key
          if (key.Token && this.session.primaryKey) {
            const decryptedToken = await openpgp.decrypt({
              message: await openpgp.readMessage({ armoredMessage: key.Token }),
              decryptionKeys: this.session.primaryKey,
            });
            addressKeyPassword = decryptedToken.data as string;
          } else if (keySalt?.KeySalt) {
            // Use password-derived key
            addressKeyPassword = await computeKeyPassword(password, keySalt.KeySalt);
          } else {
            // Fallback to the user's key password
            addressKeyPassword = this.session.keyPassword;
          }

          if (addressKeyPassword) {
            // Store armored key and passphrase instead of decrypted key
            // This allows the SDK to decrypt using its own openpgp instance
            addressData.keys.push({
              ID: key.ID,
              Primary: key.Primary,
              armoredKey: key.PrivateKey,
              passphrase: addressKeyPassword,
            });
          }
        } catch (error) {
          logger.warn(`Failed to process address key ${key.ID}:`, (error as Error).message);
        }
      }

      this.session.addresses.push(addressData);
    }
  }

  /**
   * Get current session
   */
  getSession(): Session | null {
    return this.session;
  }

  /**
   * Get credentials for session reuse (like rclone stores)
   */
  getReusableCredentials(): ReusableCredentials {
    if (!this.session) {
      throw new Error('Not authenticated');
    }
    return {
      UID: this.session.UID,
      AccessToken: this.session.AccessToken,
      RefreshToken: this.session.RefreshToken,
      SaltedKeyPass: this.session.keyPassword,
    };
  }

  /**
   * Restore session from stored credentials
   */
  async restoreSession(credentials: ReusableCredentials): Promise<Session> {
    const { UID, AccessToken, RefreshToken, SaltedKeyPass } = credentials;

    this.session = {
      UID,
      AccessToken,
      RefreshToken,
      keyPassword: SaltedKeyPass,
    };

    // Helper to refresh token when needed
    // Verify the session is still valid by fetching user info
    try {
      const userResponse = await this.apiRequestWithRefresh<ApiResponse & { User: User }>(
        'GET',
        'core/v4/users'
      );
      this.session.user = userResponse.User;

      // First, decrypt the user's primary key
      const primaryUserKey = this.session.user?.Keys?.[0];
      if (primaryUserKey && SaltedKeyPass) {
        try {
          const privateKey = await openpgp.readPrivateKey({
            armoredKey: primaryUserKey.PrivateKey,
          });
          const decryptedKey = await openpgp.decryptKey({
            privateKey,
            passphrase: SaltedKeyPass,
          });
          this.session.primaryKey = decryptedKey;
        } catch (error) {
          logger.warn('Failed to decrypt primary user key:', (error as Error).message);
        }
      }

      // Fetch addresses
      const addressesResponse = await this.apiRequestWithRefresh<
        ApiResponse & { Addresses?: Address[] }
      >('GET', 'core/v4/addresses');
      const addresses = addressesResponse.Addresses || [];

      // Process addresses and their keys
      this.session.addresses = [];
      for (const address of addresses) {
        const addressData: AddressData = {
          ID: address.ID,
          Email: address.Email,
          Type: address.Type,
          Status: address.Status,
          keys: [],
        };

        for (const key of address.Keys || []) {
          try {
            let addressKeyPassword: string | undefined;

            // If the key has a Token, decrypt it using the user's primary key
            if (key.Token && this.session.primaryKey) {
              const decryptedToken = await openpgp.decrypt({
                message: await openpgp.readMessage({ armoredMessage: key.Token }),
                decryptionKeys: this.session.primaryKey,
              });
              addressKeyPassword = decryptedToken.data as string;
            } else {
              // Fallback to the user's key password
              addressKeyPassword = SaltedKeyPass;
            }

            if (addressKeyPassword) {
              // Store armored key and passphrase instead of decrypted key
              addressData.keys.push({
                ID: key.ID,
                Primary: key.Primary,
                armoredKey: key.PrivateKey,
                passphrase: addressKeyPassword,
              });
            }
          } catch (error) {
            logger.warn(`Failed to process key ${key.ID}:`, (error as Error).message);
          }
        }

        this.session.addresses.push(addressData);
      }

      return this.session;
    } catch (error) {
      this.session = null;
      throw new Error(`Failed to restore session: ${(error as Error).message}`);
    }
  }

  /**
   * Refresh the access token
   */
  async refreshToken(): Promise<Session> {
    if (!this.session?.RefreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pm-appversion': APP_VERSION,
        'x-pm-uid': this.session.UID,
      },
      body: JSON.stringify({
        ResponseType: 'token',
        GrantType: 'refresh_token',
        RefreshToken: this.session.RefreshToken,
        RedirectURI: 'https://protonmail.com',
      }),
    });

    const json = (await response.json()) as ApiResponse & {
      AccessToken?: string;
      RefreshToken?: string;
    };

    if (!response.ok || json.Code !== 1000) {
      throw new Error(json.Error || 'Token refresh failed');
    }

    this.session.AccessToken = json.AccessToken!;
    this.session.RefreshToken = json.RefreshToken!;

    return this.session;
  }

  /**
   * Logout and revoke the session
   */
  async logout(): Promise<void> {
    if (!this.session?.UID) {
      return;
    }

    try {
      await fetch(`${API_BASE_URL}/core/v4/auth`, {
        method: 'DELETE',
        headers: createHeaders(this.session),
      });
    } catch {
      // Ignore logout errors
    }

    this.session = null;
  }
}

// ============================================================================
// SDK Integration Helpers
// ============================================================================

interface HttpClientRequest {
  url: string;
  method: string;
  headers: Headers;
  json?: Record<string, unknown>;
  body?: BodyInit;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

interface ProtonHttpClient {
  fetchJson(request: HttpClientRequest): Promise<Response>;
  fetchBlob(request: HttpClientRequest): Promise<Response>;
}

interface OwnAddress {
  email: string;
  addressId: string;
  primaryKeyIndex: number;
  keys: { id: string; key: openpgp.PrivateKey }[];
}

interface ProtonAccount {
  getOwnPrimaryAddress(): Promise<OwnAddress>;
  getOwnAddress(emailOrAddressId: string): Promise<OwnAddress>;
  hasProtonAccount(email: string): Promise<boolean>;
  getPublicKeys(email: string): Promise<openpgp.PublicKey[]>;
}

interface SRPVerifier {
  modulusId: string;
  version: number;
  salt: string;
  verifier: string;
}

interface SRPModuleInterface {
  getSrp(
    version: number,
    modulus: string,
    serverEphemeral: string,
    salt: string,
    password: string
  ): Promise<SrpResult>;
  getSrpVerifier(password: string): Promise<SRPVerifier>;
  computeKeyPassword(password: string, salt: string): Promise<string>;
}

/**
 * Create an HTTP client for the Proton Drive SDK
 */
export function createProtonHttpClient(
  session: Session,
  onTokenRefresh?: () => Promise<void>
): ProtonHttpClient {
  // Helper to build the full URL - handles both relative and absolute URLs
  const buildUrl = (url: string): string => {
    // If URL is already absolute, use it as-is
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // Otherwise, prepend the API base URL
    return `${API_BASE_URL}/${url}`;
  };

  // Helper to update auth headers with current session tokens
  const setAuthHeaders = (headers: Headers) => {
    if (session.UID) {
      headers.set('x-pm-uid', session.UID);
    }
    if (session.AccessToken) {
      headers.set('Authorization', `Bearer ${session.AccessToken}`);
    }
    headers.set('x-pm-appversion', APP_VERSION);
  };

  return {
    async fetchJson(request: HttpClientRequest): Promise<Response> {
      const { url, method, headers, json, timeoutMs, signal } = request;

      // Add auth headers
      setAuthHeaders(headers);

      const fullUrl = buildUrl(url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let response = await fetch(fullUrl, {
          method,
          headers,
          body: json ? JSON.stringify(json) : undefined,
          signal: signal || controller.signal,
        });

        // Handle expired access token (401) - try to refresh and retry
        if (response.status === 401 && session.RefreshToken && onTokenRefresh) {
          try {
            await onTokenRefresh();
            // Update headers with new token and retry
            setAuthHeaders(headers);
            response = await fetch(fullUrl, {
              method,
              headers,
              body: json ? JSON.stringify(json) : undefined,
              signal: signal || controller.signal,
            });
          } catch {
            // Refresh failed, return original 401 response
          }
        }

        return response;
      } finally {
        clearTimeout(timeout);
      }
    },

    async fetchBlob(request: HttpClientRequest): Promise<Response> {
      const { url, method, headers, body, timeoutMs, signal } = request;

      // Add auth headers
      setAuthHeaders(headers);

      const fullUrl = buildUrl(url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let response = await fetch(fullUrl, {
          method,
          headers,
          body,
          signal: signal || controller.signal,
        });

        // Handle expired access token (401) - try to refresh and retry
        if (response.status === 401 && session.RefreshToken && onTokenRefresh) {
          try {
            await onTokenRefresh();
            // Update headers with new token and retry
            setAuthHeaders(headers);
            response = await fetch(fullUrl, {
              method,
              headers,
              body,
              signal: signal || controller.signal,
            });
          } catch {
            // Refresh failed, return original 401 response
          }
        }

        return response;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * Create a Proton account interface for the SDK
 */
export function createProtonAccount(
  session: Session,
  cryptoModule: OpenPGPCryptoInterface
): ProtonAccount {
  // Cache for decrypted keys to avoid re-decrypting on each call
  const decryptedKeysCache = new Map<string, openpgp.PrivateKey>();

  async function decryptAddressKeys(
    keys: AddressKeyInfo[]
  ): Promise<{ id: string; key: openpgp.PrivateKey }[]> {
    const result: { id: string; key: openpgp.PrivateKey }[] = [];
    for (const k of keys) {
      let decryptedKey = decryptedKeysCache.get(k.ID);
      if (!decryptedKey) {
        decryptedKey = await cryptoModule.decryptKey(k.armoredKey, k.passphrase);
        decryptedKeysCache.set(k.ID, decryptedKey);
      }
      result.push({ id: k.ID, key: decryptedKey });
    }
    return result;
  }

  return {
    async getOwnPrimaryAddress(): Promise<OwnAddress> {
      const primaryAddress = session.addresses?.find((a) => a.Type === 1 && a.Status === 1);
      if (!primaryAddress) {
        throw new Error('No primary address found');
      }

      const primaryKeyIndex = primaryAddress.keys.findIndex((k) => k.Primary === 1);
      const keys = await decryptAddressKeys(primaryAddress.keys);
      return {
        email: primaryAddress.Email,
        addressId: primaryAddress.ID,
        primaryKeyIndex: primaryKeyIndex >= 0 ? primaryKeyIndex : 0,
        keys,
      };
    },

    async getOwnAddress(emailOrAddressId: string): Promise<OwnAddress> {
      const address = session.addresses?.find(
        (a) => a.Email === emailOrAddressId || a.ID === emailOrAddressId
      );
      if (!address) {
        throw new Error(`Address not found: ${emailOrAddressId}`);
      }

      const primaryKeyIndex = address.keys.findIndex((k) => k.Primary === 1);
      const keys = await decryptAddressKeys(address.keys);
      return {
        email: address.Email,
        addressId: address.ID,
        primaryKeyIndex: primaryKeyIndex >= 0 ? primaryKeyIndex : 0,
        keys,
      };
    },

    async hasProtonAccount(email: string): Promise<boolean> {
      // Query the key transparency endpoint to check if the email has a Proton account
      try {
        const response = await apiRequest<ApiResponse & { Keys?: unknown[] }>(
          'GET',
          `core/v4/keys?Email=${encodeURIComponent(email)}`,
          null,
          session
        );
        return response.Keys !== undefined && response.Keys.length > 0;
      } catch {
        return false;
      }
    },

    async getPublicKeys(email: string): Promise<openpgp.PublicKey[]> {
      try {
        const response = await apiRequest<ApiResponse & { Keys?: { PublicKey: string }[] }>(
          'GET',
          `core/v4/keys?Email=${encodeURIComponent(email)}`,
          null,
          session
        );

        const keys: openpgp.PublicKey[] = [];
        for (const keyData of response.Keys || []) {
          try {
            const key = await openpgp.readKey({ armoredKey: keyData.PublicKey });
            keys.push(key);
          } catch {
            // Skip invalid keys
          }
        }
        return keys;
      } catch {
        return [];
      }
    },
  };
}

/**
 * Create an SRP module for the SDK
 */
export function createSrpModule(): SRPModuleInterface {
  return {
    async getSrp(
      version: number,
      modulus: string,
      serverEphemeral: string,
      salt: string,
      password: string
    ): Promise<SrpResult> {
      const authInfo: AuthInfo = {
        Version: version,
        Modulus: modulus,
        ServerEphemeral: serverEphemeral,
        Salt: salt,
      };
      return getSrp(authInfo, { password });
    },

    async getSrpVerifier(password: string): Promise<SRPVerifier> {
      // Fetch modulus from server
      const response = await apiRequest<ApiResponse & { Modulus: string; ModulusID: string }>(
        'GET',
        'core/v4/auth/modulus'
      );
      const modulus = await verifyAndGetModulus(response.Modulus);

      // Generate random salt
      const saltBytes = crypto.getRandomValues(new Uint8Array(10));
      const salt = uint8ArrayToBinaryString(saltBytes);

      // Hash password
      const hashedPassword = await hashPassword({
        version: AUTH_VERSION,
        password,
        salt,
        modulus,
      });

      // Generate verifier
      const generator = 2n;
      const modulusBigInt = uint8ArrayToBigIntLE(modulus.slice().reverse());
      const hashedPasswordBigInt = uint8ArrayToBigIntLE(hashedPassword.slice().reverse());
      const verifier = modExp(generator, hashedPasswordBigInt, modulusBigInt);
      const verifierArray = bigIntToUint8ArrayLE(verifier, SRP_LEN);

      return {
        modulusId: response.ModulusID,
        version: AUTH_VERSION,
        salt: base64Encode(saltBytes),
        verifier: base64Encode(verifierArray),
      };
    },

    async computeKeyPassword(password: string, salt: string): Promise<string> {
      return computeKeyPassword(password, salt);
    },
  };
}

// ============================================================================
// OpenPGP Crypto Wrapper
// ============================================================================

interface SessionKey {
  data: Uint8Array;
  algorithm: string;
}

interface OpenPGPCryptoInterface {
  generatePassphrase(): string;
  generateSessionKey(encryptionKeys: openpgp.PrivateKey[]): Promise<SessionKey>;
  encryptSessionKey(
    sessionKey: SessionKey,
    encryptionKeys: openpgp.PublicKey | openpgp.PublicKey[]
  ): Promise<{ keyPacket: Uint8Array }>;
  encryptSessionKeyWithPassword(
    sessionKey: SessionKey,
    password: string
  ): Promise<{ keyPacket: Uint8Array }>;
  generateKey(passphrase: string): Promise<{ privateKey: openpgp.PrivateKey; armoredKey: string }>;
  encryptArmored(
    data: Uint8Array,
    encryptionKeys: openpgp.PrivateKey[],
    sessionKey?: SessionKey
  ): Promise<{ armoredData: string }>;
  encryptAndSign(
    data: Uint8Array,
    sessionKey: SessionKey,
    encryptionKeys: openpgp.PrivateKey[],
    signingKey: openpgp.PrivateKey
  ): Promise<{ encryptedData: Uint8Array }>;
  encryptAndSignArmored(
    data: Uint8Array,
    sessionKey: SessionKey | undefined,
    encryptionKeys: openpgp.PrivateKey[],
    signingKey: openpgp.PrivateKey
  ): Promise<{ armoredData: string }>;
  encryptAndSignDetached(
    data: Uint8Array,
    sessionKey: SessionKey,
    encryptionKeys: openpgp.PrivateKey[],
    signingKey: openpgp.PrivateKey
  ): Promise<{ encryptedData: Uint8Array; signature: Uint8Array }>;
  encryptAndSignDetachedArmored(
    data: Uint8Array,
    sessionKey: SessionKey,
    encryptionKeys: openpgp.PrivateKey[],
    signingKey: openpgp.PrivateKey
  ): Promise<{ armoredData: string; armoredSignature: string }>;
  sign(
    data: Uint8Array,
    signingKey: openpgp.PrivateKey,
    signatureContext?: string
  ): Promise<{ signature: Uint8Array }>;
  signArmored(
    data: Uint8Array,
    signingKey: openpgp.PrivateKey | openpgp.PrivateKey[]
  ): Promise<{ signature: string }>;
  verify(
    data: Uint8Array,
    signature: Uint8Array,
    verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
  ): Promise<{ verified: number; verificationErrors?: Error[] }>;
  verifyArmored(
    data: Uint8Array,
    armoredSignature: string,
    verificationKeys: openpgp.PublicKey | openpgp.PublicKey[],
    signatureContext?: string
  ): Promise<{ verified: number; verificationErrors?: Error[] }>;
  decryptSessionKey(
    data: Uint8Array,
    decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[]
  ): Promise<SessionKey>;
  decryptArmoredSessionKey(
    armoredData: string,
    decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[]
  ): Promise<SessionKey>;
  decryptKey(armoredKey: string, passphrase: string): Promise<openpgp.PrivateKey>;
  decryptAndVerify(
    data: Uint8Array,
    sessionKey: SessionKey,
    verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
  ): Promise<{ data: Uint8Array; verified: number }>;
  decryptAndVerifyDetached(
    data: Uint8Array,
    signature: Uint8Array | undefined,
    sessionKey: SessionKey,
    verificationKeys?: openpgp.PublicKey | openpgp.PublicKey[]
  ): Promise<{ data: Uint8Array; verified: number }>;
  decryptArmored(
    armoredData: string,
    decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[]
  ): Promise<Uint8Array>;
  decryptArmoredAndVerify(
    armoredData: string,
    decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[],
    verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
  ): Promise<{ data: Uint8Array; verified: number }>;
  decryptArmoredAndVerifyDetached(
    armoredData: string,
    armoredSignature: string | undefined,
    sessionKey: SessionKey,
    verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
  ): Promise<{ data: Uint8Array; verified: number }>;
  decryptArmoredWithPassword(armoredData: string, password: string): Promise<Uint8Array>;
}

const VERIFICATION_STATUS = {
  NOT_SIGNED: 0,
  SIGNED_AND_VALID: 1,
  SIGNED_AND_INVALID: 2,
};

/**
 * Create an OpenPGP crypto wrapper for the SDK
 */
export function createOpenPGPCrypto(): OpenPGPCryptoInterface {
  const toArray = <T>(val: T | T[]): T[] => (Array.isArray(val) ? val : [val]);

  return {
    generatePassphrase(): string {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      return base64Encode(bytes);
    },

    async generateSessionKey(encryptionKeys: openpgp.PrivateKey[]): Promise<SessionKey> {
      return (await openpgp.generateSessionKey({
        encryptionKeys: toArray(encryptionKeys),
      })) as SessionKey;
    },

    async encryptSessionKey(
      sessionKey: SessionKey,
      encryptionKeys: openpgp.PublicKey | openpgp.PublicKey[]
    ): Promise<{ keyPacket: Uint8Array }> {
      const result = await openpgp.encryptSessionKey({
        data: sessionKey.data,
        algorithm: sessionKey.algorithm,
        encryptionKeys: toArray(encryptionKeys),
        format: 'binary',
      });
      return { keyPacket: result as Uint8Array };
    },

    async encryptSessionKeyWithPassword(
      sessionKey: SessionKey,
      password: string
    ): Promise<{ keyPacket: Uint8Array }> {
      const result = await openpgp.encryptSessionKey({
        data: sessionKey.data,
        algorithm: sessionKey.algorithm,
        passwords: [password],
        format: 'binary',
      });
      return { keyPacket: result as Uint8Array };
    },

    async generateKey(
      passphrase: string
    ): Promise<{ privateKey: openpgp.PrivateKey; armoredKey: string }> {
      // Generate an unencrypted key first
      const { privateKey: decryptedKey } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'curve25519' as openpgp.EllipticCurveName,
        userIDs: [{ name: 'Drive', email: 'drive@proton.me' }],
        format: 'object',
      });
      // Encrypt the key with the passphrase for storage
      const encryptedKey = await openpgp.encryptKey({
        privateKey: decryptedKey,
        passphrase,
      });
      const armoredKey = encryptedKey.armor();
      // Return the DECRYPTED key for immediate use, and the ENCRYPTED armored key for storage
      return { privateKey: decryptedKey, armoredKey };
    },

    async encryptArmored(
      data: Uint8Array,
      encryptionKeys: openpgp.PrivateKey[],
      sessionKey?: SessionKey
    ): Promise<{ armoredData: string }> {
      const message = await openpgp.createMessage({ binary: data });
      const armoredData = (await openpgp.encrypt({
        message,
        encryptionKeys: toArray(encryptionKeys),
        sessionKey,
        format: 'armored',
      })) as string;
      return { armoredData };
    },

    async encryptAndSign(
      data: Uint8Array,
      sessionKey: SessionKey,
      encryptionKeys: openpgp.PrivateKey[],
      signingKey: openpgp.PrivateKey
    ): Promise<{ encryptedData: Uint8Array }> {
      const message = await openpgp.createMessage({ binary: data });
      const encryptedData = (await openpgp.encrypt({
        message,
        encryptionKeys: toArray(encryptionKeys),
        signingKeys: [signingKey],
        sessionKey,
        format: 'binary',
      })) as Uint8Array;
      return { encryptedData };
    },

    async encryptAndSignArmored(
      data: Uint8Array,
      sessionKey: SessionKey | undefined,
      encryptionKeys: openpgp.PrivateKey[],
      signingKey: openpgp.PrivateKey
    ): Promise<{ armoredData: string }> {
      const message = await openpgp.createMessage({ binary: data });
      const armoredData = (await openpgp.encrypt({
        message,
        encryptionKeys: toArray(encryptionKeys),
        signingKeys: [signingKey],
        sessionKey,
        format: 'armored',
      })) as string;
      return { armoredData };
    },

    async encryptAndSignDetached(
      data: Uint8Array,
      sessionKey: SessionKey,
      encryptionKeys: openpgp.PrivateKey[],
      signingKey: openpgp.PrivateKey
    ): Promise<{ encryptedData: Uint8Array; signature: Uint8Array }> {
      const message = await openpgp.createMessage({ binary: data });
      const [encryptedData, signatureResult] = await Promise.all([
        openpgp.encrypt({
          message,
          encryptionKeys: toArray(encryptionKeys),
          sessionKey,
          format: 'binary',
        }) as Promise<Uint8Array>,
        openpgp.sign({
          message,
          signingKeys: [signingKey],
          detached: true,
          format: 'binary',
        }) as Promise<Uint8Array>,
      ]);
      return { encryptedData, signature: signatureResult };
    },

    async encryptAndSignDetachedArmored(
      data: Uint8Array,
      sessionKey: SessionKey,
      encryptionKeys: openpgp.PrivateKey[],
      signingKey: openpgp.PrivateKey
    ): Promise<{ armoredData: string; armoredSignature: string }> {
      const message = await openpgp.createMessage({ binary: data });
      const [armoredData, armoredSignature] = await Promise.all([
        openpgp.encrypt({
          message,
          encryptionKeys: toArray(encryptionKeys),
          sessionKey,
          format: 'armored',
        }) as Promise<string>,
        openpgp.sign({
          message,
          signingKeys: [signingKey],
          detached: true,
          format: 'armored',
        }) as Promise<string>,
      ]);
      return { armoredData, armoredSignature };
    },

    async sign(
      data: Uint8Array,
      signingKey: openpgp.PrivateKey,
      signatureContext?: string
    ): Promise<{ signature: Uint8Array }> {
      const message = await openpgp.createMessage({ binary: data });
      // Context is supported in openpgp but types may not reflect it - ignoring context for now
      void signatureContext;
      const signature = (await openpgp.sign({
        message,
        signingKeys: [signingKey],
        detached: true,
        format: 'binary',
      })) as Uint8Array;
      return { signature };
    },

    async signArmored(
      data: Uint8Array,
      signingKey: openpgp.PrivateKey | openpgp.PrivateKey[]
    ): Promise<{ signature: string }> {
      const message = await openpgp.createMessage({ binary: data });
      const signature = (await openpgp.sign({
        message,
        signingKeys: toArray(signingKey),
        detached: true,
        format: 'armored',
      })) as string;
      return { signature };
    },

    async verify(
      data: Uint8Array,
      signature: Uint8Array,
      verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
    ): Promise<{ verified: number; verificationErrors?: Error[] }> {
      try {
        const message = await openpgp.createMessage({ binary: data });
        const sig = await openpgp.readSignature({ binarySignature: signature });
        const result = await openpgp.verify({
          message,
          signature: sig,
          verificationKeys: toArray(verificationKeys),
        });

        const verified = await result.signatures[0]?.verified.catch(() => false);
        return {
          verified: verified
            ? VERIFICATION_STATUS.SIGNED_AND_VALID
            : VERIFICATION_STATUS.SIGNED_AND_INVALID,
        };
      } catch (error) {
        return {
          verified: VERIFICATION_STATUS.SIGNED_AND_INVALID,
          verificationErrors: [error as Error],
        };
      }
    },

    async verifyArmored(
      data: Uint8Array,
      armoredSignature: string,
      verificationKeys: openpgp.PublicKey | openpgp.PublicKey[],
      signatureContext?: string
    ): Promise<{ verified: number; verificationErrors?: Error[] }> {
      try {
        const message = await openpgp.createMessage({ binary: data });
        const signature = await openpgp.readSignature({ armoredSignature });
        // Context is supported in openpgp but types may not reflect it - ignoring for now
        void signatureContext;
        const result = await openpgp.verify({
          message,
          signature,
          verificationKeys: toArray(verificationKeys),
        });

        const verified = await result.signatures[0]?.verified.catch(() => false);
        return {
          verified: verified
            ? VERIFICATION_STATUS.SIGNED_AND_VALID
            : VERIFICATION_STATUS.SIGNED_AND_INVALID,
        };
      } catch (error) {
        return {
          verified: VERIFICATION_STATUS.SIGNED_AND_INVALID,
          verificationErrors: [error as Error],
        };
      }
    },

    async decryptSessionKey(
      data: Uint8Array,
      decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[]
    ): Promise<SessionKey> {
      const message = await openpgp.readMessage({ binaryMessage: data });
      const result = await openpgp.decryptSessionKeys({
        message,
        decryptionKeys: toArray(decryptionKeys),
      });
      return result[0] as SessionKey;
    },

    async decryptArmoredSessionKey(
      armoredData: string,
      decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[]
    ): Promise<SessionKey> {
      const message = await openpgp.readMessage({ armoredMessage: armoredData });
      const result = await openpgp.decryptSessionKeys({
        message,
        decryptionKeys: toArray(decryptionKeys),
      });
      return result[0] as SessionKey;
    },

    async decryptKey(armoredKey: string, passphrase: string): Promise<openpgp.PrivateKey> {
      const privateKey = await openpgp.readPrivateKey({ armoredKey });
      return await openpgp.decryptKey({ privateKey, passphrase });
    },

    async decryptAndVerify(
      data: Uint8Array,
      sessionKey: SessionKey,
      verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
    ): Promise<{ data: Uint8Array; verified: number }> {
      const message = await openpgp.readMessage({ binaryMessage: data });
      const result = await openpgp.decrypt({
        message,
        sessionKeys: [sessionKey],
        verificationKeys: toArray(verificationKeys),
        format: 'binary',
      });

      let verified = VERIFICATION_STATUS.NOT_SIGNED;
      if (result.signatures?.length > 0) {
        const sigVerified = await result.signatures[0].verified.catch(() => false);
        verified = sigVerified
          ? VERIFICATION_STATUS.SIGNED_AND_VALID
          : VERIFICATION_STATUS.SIGNED_AND_INVALID;
      }

      return { data: result.data as Uint8Array, verified };
    },

    async decryptAndVerifyDetached(
      data: Uint8Array,
      signature: Uint8Array | undefined,
      sessionKey: SessionKey,
      verificationKeys?: openpgp.PublicKey | openpgp.PublicKey[]
    ): Promise<{ data: Uint8Array; verified: number }> {
      const message = await openpgp.readMessage({ binaryMessage: data });
      const result = await openpgp.decrypt({
        message,
        sessionKeys: [sessionKey],
        format: 'binary',
      });

      let verified = VERIFICATION_STATUS.NOT_SIGNED;
      if (signature && verificationKeys) {
        const sig = await openpgp.readSignature({ binarySignature: signature });
        const verifyResult = await openpgp.verify({
          message: await openpgp.createMessage({ binary: result.data as Uint8Array }),
          signature: sig,
          verificationKeys: toArray(verificationKeys),
        });
        const sigVerified = await verifyResult.signatures[0]?.verified.catch(() => false);
        verified = sigVerified
          ? VERIFICATION_STATUS.SIGNED_AND_VALID
          : VERIFICATION_STATUS.SIGNED_AND_INVALID;
      }

      return { data: result.data as Uint8Array, verified };
    },

    async decryptArmored(
      armoredData: string,
      decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[]
    ): Promise<Uint8Array> {
      const message = await openpgp.readMessage({ armoredMessage: armoredData });
      const result = await openpgp.decrypt({
        message,
        decryptionKeys: toArray(decryptionKeys),
        format: 'binary',
      });
      return result.data as Uint8Array;
    },

    async decryptArmoredAndVerify(
      armoredData: string,
      decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[],
      verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
    ): Promise<{ data: Uint8Array; verified: number }> {
      const message = await openpgp.readMessage({ armoredMessage: armoredData });
      const result = await openpgp.decrypt({
        message,
        decryptionKeys: toArray(decryptionKeys),
        verificationKeys: toArray(verificationKeys),
        format: 'binary',
      });

      let verified = VERIFICATION_STATUS.NOT_SIGNED;
      if (result.signatures?.length > 0) {
        const sigVerified = await result.signatures[0].verified.catch(() => false);
        verified = sigVerified
          ? VERIFICATION_STATUS.SIGNED_AND_VALID
          : VERIFICATION_STATUS.SIGNED_AND_INVALID;
      }

      return { data: result.data as Uint8Array, verified };
    },

    async decryptArmoredAndVerifyDetached(
      armoredData: string,
      armoredSignature: string | undefined,
      sessionKey: SessionKey,
      verificationKeys: openpgp.PublicKey | openpgp.PublicKey[]
    ): Promise<{ data: Uint8Array; verified: number }> {
      const message = await openpgp.readMessage({ armoredMessage: armoredData });
      const result = await openpgp.decrypt({
        message,
        sessionKeys: [sessionKey],
        format: 'binary',
      });

      let verified = VERIFICATION_STATUS.NOT_SIGNED;
      if (armoredSignature && verificationKeys) {
        const signature = await openpgp.readSignature({ armoredSignature });
        const verifyResult = await openpgp.verify({
          message: await openpgp.createMessage({ binary: result.data as Uint8Array }),
          signature,
          verificationKeys: toArray(verificationKeys),
        });
        const sigVerified = await verifyResult.signatures[0]?.verified.catch(() => false);
        verified = sigVerified
          ? VERIFICATION_STATUS.SIGNED_AND_VALID
          : VERIFICATION_STATUS.SIGNED_AND_INVALID;
      }

      return { data: result.data as Uint8Array, verified };
    },

    async decryptArmoredWithPassword(armoredData: string, password: string): Promise<Uint8Array> {
      const message = await openpgp.readMessage({ armoredMessage: armoredData });
      const result = await openpgp.decrypt({
        message,
        passwords: [password],
        format: 'binary',
      });
      return result.data as Uint8Array;
    },
  };
}

/**
 * Initialize crypto (openpgp configuration)
 */
export async function initCrypto(): Promise<void> {
  // Configure openpgp for optimal performance
  openpgp.config.allowInsecureDecryptionWithSigningKeys = true;
}

// Export openpgp for external use
export { openpgp };

// Default export for convenience
export default {
  ProtonAuth,
  createProtonHttpClient,
  createProtonAccount,
  createSrpModule,
  createOpenPGPCrypto,
  initCrypto,
};
