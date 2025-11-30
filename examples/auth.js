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

// ============================================================================
// Constants
// ============================================================================

const API_BASE_URL = 'https://api.protonmail.ch';
const SRP_LEN = 256; // 2048 / 8, in bytes
const AUTH_VERSION = 4;
const BCRYPT_PREFIX = '$2y$10$';
const APP_VERSION = 'macos-drive@1.0.0-alpha.1+rclone';

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
function uint8ArrayToBigIntLE(arr) {
    let result = 0n;
    for (let i = arr.length - 1; i >= 0; i--) {
        result = (result << 8n) | BigInt(arr[arr.length - 1 - i]);
    }
    return result;
}

/**
 * Convert BigInt to Uint8Array (little-endian)
 */
function bigIntToUint8ArrayLE(num, length) {
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
function bigIntByteLength(num) {
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
function modExp(base, exp, modulus) {
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
function mod(n, m) {
    return ((n % m) + m) % m;
}

// ============================================================================
// Crypto Utilities
// ============================================================================

/**
 * Compute SHA-512 hash
 */
async function sha512(data) {
    const buffer = await crypto.subtle.digest('SHA-512', data);
    return new Uint8Array(buffer);
}

/**
 * Expand hash using SHA-512 (concatenating 4 hashes with indices)
 */
async function expandHash(input) {
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
function base64Encode(arr) {
    return btoa(String.fromCharCode(...arr));
}

/**
 * Base64 decode to Uint8Array
 */
function base64Decode(str) {
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
function stringToUint8Array(str) {
    return new TextEncoder().encode(str);
}

/**
 * Convert binary string to Uint8Array (treats each char as a byte value)
 * This is different from stringToUint8Array which uses UTF-8 encoding
 */
function binaryStringToArray(str) {
    const result = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        result[i] = str.charCodeAt(i);
    }
    return result;
}

/**
 * Convert Uint8Array to binary string
 */
function uint8ArrayToBinaryString(arr) {
    return String.fromCharCode(...arr);
}

/**
 * Merge multiple Uint8Arrays
 */
function mergeUint8Arrays(arrays) {
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
function bcryptEncodeBase64(data, length) {
    const BCRYPT_CHARS = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    let off = 0;
    let c1, c2;

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

/**
 * Hash password using bcrypt and expand with SHA-512
 */
async function formatHash(password, salt, modulus) {
    const hash = bcrypt.hashSync(password, BCRYPT_PREFIX + salt);
    const hashBytes = stringToUint8Array(hash);
    return expandHash(mergeUint8Arrays([hashBytes, modulus]));
}

/**
 * Hash password for auth version 3+
 */
async function hashPasswordV3(password, salt, modulus) {
    // salt is a binary string (from base64 decode), so we must use binaryStringToArray
    // not stringToUint8Array (which would UTF-8 encode and corrupt bytes > 127)
    const saltBinary = binaryStringToArray(salt + 'proton');
    const bcryptSalt = bcryptEncodeBase64(saltBinary, 16);
    return formatHash(password, bcryptSalt, modulus);
}

/**
 * Hash password based on auth version
 */
async function hashPassword({ password, salt, modulus, version }) {
    if (version >= 3) {
        if (!salt) throw new Error('Missing salt for auth version >= 3');
        return hashPasswordV3(password, salt, modulus);
    }
    throw new Error(`Unsupported auth version: ${version}`);
}

/**
 * Compute key password from password and salt using bcrypt
 */
async function computeKeyPassword(password, salt) {
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

/**
 * Verify and extract modulus from signed message
 */
async function verifyAndGetModulus(signedModulus) {
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
async function generateProofs({ byteLength, modulusArray, hashedPasswordArray, serverEphemeralArray }) {
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
    let clientSecret, clientEphemeral, scramblingParam;
    for (let i = 0; i < 1000; i++) {
        const randomBytes = crypto.getRandomValues(new Uint8Array(byteLength));
        clientSecret = uint8ArrayToBigIntLE(randomBytes.slice().reverse());
        clientEphemeral = modExp(generator, clientSecret, modulus);

        const clientEphemeralArray = bigIntToUint8ArrayLE(clientEphemeral, byteLength);
        const clientServerHash = await expandHash(mergeUint8Arrays([clientEphemeralArray, serverEphemeralArray]));
        scramblingParam = uint8ArrayToBigIntLE(clientServerHash.slice().reverse());

        if (scramblingParam !== 0n && clientEphemeral !== 0n) {
            break;
        }
    }

    // Calculate shared session key
    const kgx = mod(modExp(generator, hashedPassword, modulus) * multiplierReduced, modulus);
    const sharedSessionKeyExponent = mod(scramblingParam * hashedPassword + clientSecret, modulusMinusOne);
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
async function getSrp(authInfo, credentials) {
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
function createHeaders(session = null) {
    const headers = {
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
async function apiRequest(method, endpoint, data = null, session = null) {
    const url = `${API_BASE_URL}/${endpoint}`;
    const options = {
        method,
        headers: createHeaders(session),
    };
    if (data) {
        options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    const json = await response.json();

    if (!response.ok || json.Code !== 1000) {
        const error = new Error(json.Error || `API error: ${response.status}`);
        error.code = json.Code;
        error.response = json;
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
    constructor() {
        this.session = null;
        this.pendingAuthResponse = null;
    }

    /**
     * Authenticate with username and password
     * @param {string} username - Proton username
     * @param {string} password - Proton password
     * @param {string} [twoFactorCode] - Optional 2FA code
     * @returns {Promise<Object>} Session info
     */
    async login(username, password, twoFactorCode = null) {
        // Get auth info
        const authInfo = await apiRequest('POST', 'core/v4/auth/info', { Username: username });

        // Generate SRP proofs
        const { clientEphemeral, clientProof, expectedServerProof } = await getSrp(authInfo, { password });

        // Authenticate
        const authData = {
            Username: username,
            ClientEphemeral: clientEphemeral,
            ClientProof: clientProof,
            SRPSession: authInfo.SRPSession,
            PersistentCookies: 0,
        };

        if (twoFactorCode) {
            authData.TwoFactorCode = twoFactorCode;
        }

        const authResponse = await apiRequest('POST', 'core/v4/auth', authData);

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

            const error = new Error('2FA required');
            error.requires2FA = true;
            error.twoFAInfo = authResponse['2FA'];
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
     * @param {string} code - 2FA code
     */
    async submit2FA(code) {
        if (!this.session?.UID) {
            throw new Error('No pending 2FA authentication');
        }

        const response = await apiRequest(
            'POST',
            'core/v4/auth/2fa',
            { TwoFactorCode: code },
            this.session
        );

        // Update session with new tokens if provided
        if (response.AccessToken) {
            this.session.AccessToken = response.AccessToken;
        }
        if (response.RefreshToken) {
            this.session.RefreshToken = response.RefreshToken;
        }

        return this.session;
    }

    /**
     * Fetch user data after successful authentication
     */
    async fetchUserData() {
        if (!this.session?.password) {
            throw new Error('Password not available for key decryption');
        }
        // This is called after 2FA to complete the session setup
        // The password should have been stored during initial login attempt
    }

    /**
     * Fetch user information and decrypt keys
     * @private
     */
    async _fetchUserAndKeys(password) {
        // Fetch user info
        const userResponse = await apiRequest('GET', 'core/v4/users', null, this.session);
        this.session.user = userResponse.User;

        // Fetch key salts
        const saltsResponse = await apiRequest('GET', 'core/v4/keys/salts', null, this.session);
        const keySalts = saltsResponse.KeySalts || [];

        // Fetch addresses
        const addressesResponse = await apiRequest('GET', 'core/v4/addresses', null, this.session);
        const addresses = addressesResponse.Addresses || [];

        // Find primary key and its salt
        const primaryKey = this.session.user.Keys?.[0];
        if (primaryKey) {
            const keySalt = keySalts.find(s => s.ID === primaryKey.ID);

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
                    console.warn('Failed to decrypt primary key:', error.message);
                }
            }
        }

        // Process addresses and their keys
        this.session.addresses = [];
        for (const address of addresses) {
            const addressData = {
                ID: address.ID,
                Email: address.Email,
                Type: address.Type,
                Status: address.Status,
                keys: [],
            };

            for (const key of address.Keys || []) {
                const keySalt = keySalts.find(s => s.ID === key.ID);
                if (keySalt?.KeySalt) {
                    try {
                        const keyPassword = await computeKeyPassword(password, keySalt.KeySalt);
                        const privateKey = await openpgp.readPrivateKey({
                            armoredKey: key.PrivateKey,
                        });
                        const decryptedKey = await openpgp.decryptKey({
                            privateKey,
                            passphrase: keyPassword,
                        });
                        addressData.keys.push({
                            ID: key.ID,
                            Primary: key.Primary,
                            key: decryptedKey,
                        });
                    } catch (error) {
                        console.warn(`Failed to decrypt key ${key.ID}:`, error.message);
                    }
                }
            }

            this.session.addresses.push(addressData);
        }
    }

    /**
     * Get current session
     * @returns {Object|null} Current session or null if not authenticated
     */
    getSession() {
        return this.session;
    }

    /**
     * Get credentials for session reuse (like rclone stores)
     * @returns {Object} Reusable credentials
     */
    getReusableCredentials() {
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
     * @param {Object} credentials - Stored credentials
     * @returns {Promise<Object>} Session info
     */
    async restoreSession(credentials) {
        const { UID, AccessToken, RefreshToken, SaltedKeyPass } = credentials;

        this.session = {
            UID,
            AccessToken,
            RefreshToken,
            keyPassword: SaltedKeyPass,
        };

        // Verify the session is still valid by fetching user info
        try {
            const userResponse = await apiRequest('GET', 'core/v4/users', null, this.session);
            this.session.user = userResponse.User;

            // Fetch addresses
            const addressesResponse = await apiRequest('GET', 'core/v4/addresses', null, this.session);
            const addresses = addressesResponse.Addresses || [];

            // Process addresses and their keys
            this.session.addresses = [];
            for (const address of addresses) {
                const addressData = {
                    ID: address.ID,
                    Email: address.Email,
                    Type: address.Type,
                    Status: address.Status,
                    keys: [],
                };

                for (const key of address.Keys || []) {
                    try {
                        const privateKey = await openpgp.readPrivateKey({
                            armoredKey: key.PrivateKey,
                        });
                        const decryptedKey = await openpgp.decryptKey({
                            privateKey,
                            passphrase: SaltedKeyPass,
                        });
                        addressData.keys.push({
                            ID: key.ID,
                            Primary: key.Primary,
                            key: decryptedKey,
                        });
                    } catch (error) {
                        console.warn(`Failed to decrypt key ${key.ID}:`, error.message);
                    }
                }

                this.session.addresses.push(addressData);
            }

            return this.session;
        } catch (error) {
            this.session = null;
            throw new Error(`Failed to restore session: ${error.message}`);
        }
    }

    /**
     * Refresh the access token
     * @returns {Promise<Object>} Updated session
     */
    async refreshToken() {
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

        const json = await response.json();

        if (!response.ok || json.Code !== 1000) {
            throw new Error(json.Error || 'Token refresh failed');
        }

        this.session.AccessToken = json.AccessToken;
        this.session.RefreshToken = json.RefreshToken;

        return this.session;
    }

    /**
     * Logout and revoke the session
     */
    async logout() {
        if (!this.session?.UID) {
            return;
        }

        try {
            await fetch(`${API_BASE_URL}/core/v4/auth`, {
                method: 'DELETE',
                headers: createHeaders(this.session),
            });
        } catch (error) {
            // Ignore logout errors
        }

        this.session = null;
    }
}

// ============================================================================
// SDK Integration Helpers
// ============================================================================

/**
 * Create an HTTP client for the Proton Drive SDK
 * @param {Object} session - Auth session
 * @param {Object} options - Options
 * @param {boolean} options.debug - Enable debug logging
 * @returns {Object} HTTP client compatible with ProtonDriveHTTPClient interface
 */
export function createProtonHttpClient(session, options = {}) {
    const debug = options.debug || false;

    return {
        async fetchJson(request) {
            const { url, method, headers, json, timeoutMs, signal } = request;

            // Add auth headers
            if (session.UID) {
                headers.set('x-pm-uid', session.UID);
            }
            if (session.AccessToken) {
                headers.set('Authorization', `Bearer ${session.AccessToken}`);
            }
            headers.set('x-pm-appversion', APP_VERSION);

            const fullUrl = `${API_BASE_URL}/${url}`;

            if (debug) {
                console.log('\n[DEBUG] === HTTP Request ===');
                console.log(`[DEBUG] ${method} ${fullUrl}`);
                console.log('[DEBUG] Headers:', Object.fromEntries(headers.entries()));
                if (json) {
                    console.log('[DEBUG] Body:', JSON.stringify(json, null, 2));
                }
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(fullUrl, {
                    method,
                    headers,
                    body: json ? JSON.stringify(json) : undefined,
                    signal: signal || controller.signal,
                });

                if (debug) {
                    console.log(`[DEBUG] Response Status: ${response.status} ${response.statusText}`);
                    // Clone to read body for debugging
                    const cloned = response.clone();
                    try {
                        const responseBody = await cloned.json();
                        console.log('[DEBUG] Response Body:', JSON.stringify(responseBody, null, 2));
                    } catch (e) {
                        console.log('[DEBUG] Response Body: (could not parse as JSON)');
                    }
                }

                return response;
            } finally {
                clearTimeout(timeout);
            }
        },

        async fetchBlob(request) {
            const { url, method, headers, body, timeoutMs, signal, onProgress } = request;

            // Add auth headers
            if (session.UID) {
                headers.set('x-pm-uid', session.UID);
            }
            if (session.AccessToken) {
                headers.set('Authorization', `Bearer ${session.AccessToken}`);
            }
            headers.set('x-pm-appversion', APP_VERSION);

            const fullUrl = `${API_BASE_URL}/${url}`;

            if (debug) {
                console.log('\n[DEBUG] === HTTP Blob Request ===');
                console.log(`[DEBUG] ${method} ${fullUrl}`);
                console.log('[DEBUG] Headers:', Object.fromEntries(headers.entries()));
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(fullUrl, {
                    method,
                    headers,
                    body,
                    signal: signal || controller.signal,
                });

                if (debug) {
                    console.log(`[DEBUG] Blob Response Status: ${response.status} ${response.statusText}`);
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
 * @param {Object} session - Auth session
 * @returns {Object} Account interface compatible with ProtonDriveAccount
 */
export function createProtonAccount(session) {
    return {
        async getOwnPrimaryAddress() {
            const primaryAddress = session.addresses?.find(a => a.Type === 1 && a.Status === 1);
            if (!primaryAddress) {
                throw new Error('No primary address found');
            }

            const primaryKeyIndex = primaryAddress.keys.findIndex(k => k.Primary === 1);
            return {
                email: primaryAddress.Email,
                addressId: primaryAddress.ID,
                primaryKeyIndex: primaryKeyIndex >= 0 ? primaryKeyIndex : 0,
                keys: primaryAddress.keys.map(k => ({
                    id: k.ID,
                    key: k.key,
                })),
            };
        },

        async getOwnAddress(emailOrAddressId) {
            const address = session.addresses?.find(
                a => a.Email === emailOrAddressId || a.ID === emailOrAddressId
            );
            if (!address) {
                throw new Error(`Address not found: ${emailOrAddressId}`);
            }

            const primaryKeyIndex = address.keys.findIndex(k => k.Primary === 1);
            return {
                email: address.Email,
                addressId: address.ID,
                primaryKeyIndex: primaryKeyIndex >= 0 ? primaryKeyIndex : 0,
                keys: address.keys.map(k => ({
                    id: k.ID,
                    key: k.key,
                })),
            };
        },

        async hasProtonAccount(email) {
            // Query the key transparency endpoint to check if the email has a Proton account
            try {
                const response = await apiRequest(
                    'GET',
                    `core/v4/keys?Email=${encodeURIComponent(email)}`,
                    null,
                    session
                );
                return response.Keys && response.Keys.length > 0;
            } catch {
                return false;
            }
        },

        async getPublicKeys(email) {
            try {
                const response = await apiRequest(
                    'GET',
                    `core/v4/keys?Email=${encodeURIComponent(email)}`,
                    null,
                    session
                );

                const keys = [];
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
 * @returns {Object} SRP module compatible with SRPModule interface
 */
export function createSrpModule() {
    return {
        async getSrp(version, modulus, serverEphemeral, salt, password) {
            const authInfo = {
                Version: version,
                Modulus: modulus,
                ServerEphemeral: serverEphemeral,
                Salt: salt,
            };
            return getSrp(authInfo, { password });
        },

        async getSrpVerifier(password) {
            // Fetch modulus from server
            const response = await apiRequest('GET', 'core/v4/auth/modulus');
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

        async computeKeyPassword(password, salt) {
            return computeKeyPassword(password, salt);
        },
    };
}

/**
 * Create an OpenPGP crypto wrapper for the SDK
 * @returns {Object} OpenPGP crypto module compatible with OpenPGPCrypto interface
 */
export function createOpenPGPCrypto() {
    const VERIFICATION_STATUS = {
        NOT_SIGNED: 0,
        SIGNED_AND_VALID: 1,
        SIGNED_AND_INVALID: 2,
    };

    const toArray = (val) => (Array.isArray(val) ? val : [val]);

    return {
        generatePassphrase() {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            return base64Encode(bytes);
        },

        async generateSessionKey(encryptionKeys) {
            return await openpgp.generateSessionKey({
                encryptionKeys: toArray(encryptionKeys),
            });
        },

        async encryptSessionKey(sessionKey, encryptionKeys) {
            const result = await openpgp.encryptSessionKey({
                data: sessionKey.data,
                algorithm: sessionKey.algorithm,
                encryptionKeys: toArray(encryptionKeys),
                format: 'binary',
            });
            return { keyPacket: result };
        },

        async encryptSessionKeyWithPassword(sessionKey, password) {
            const result = await openpgp.encryptSessionKey({
                data: sessionKey.data,
                algorithm: sessionKey.algorithm,
                passwords: [password],
                format: 'binary',
            });
            return { keyPacket: result };
        },

        async generateKey(passphrase) {
            const { privateKey } = await openpgp.generateKey({
                type: 'ecc',
                curve: 'curve25519',
                userIDs: [{ name: 'Drive', email: 'drive@proton.me' }],
                passphrase,
                format: 'object',
            });
            const armoredKey = privateKey.armor();
            return { privateKey, armoredKey };
        },

        async encryptArmored(data, encryptionKeys, sessionKey) {
            const message = await openpgp.createMessage({ binary: data });
            const armoredData = await openpgp.encrypt({
                message,
                encryptionKeys: toArray(encryptionKeys),
                sessionKey,
                format: 'armored',
            });
            return { armoredData };
        },

        async encryptAndSign(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const encryptedData = await openpgp.encrypt({
                message,
                encryptionKeys: toArray(encryptionKeys),
                signingKeys: [signingKey],
                sessionKey,
                format: 'binary',
            });
            return { encryptedData };
        },

        async encryptAndSignArmored(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const armoredData = await openpgp.encrypt({
                message,
                encryptionKeys: toArray(encryptionKeys),
                signingKeys: [signingKey],
                sessionKey,
                format: 'armored',
            });
            return { armoredData };
        },

        async encryptAndSignDetached(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const [encryptedData, signatureResult] = await Promise.all([
                openpgp.encrypt({
                    message,
                    encryptionKeys: toArray(encryptionKeys),
                    sessionKey,
                    format: 'binary',
                }),
                openpgp.sign({
                    message,
                    signingKeys: [signingKey],
                    detached: true,
                    format: 'binary',
                }),
            ]);
            return { encryptedData, signature: signatureResult };
        },

        async encryptAndSignDetachedArmored(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const [armoredData, armoredSignature] = await Promise.all([
                openpgp.encrypt({
                    message,
                    encryptionKeys: toArray(encryptionKeys),
                    sessionKey,
                    format: 'armored',
                }),
                openpgp.sign({
                    message,
                    signingKeys: [signingKey],
                    detached: true,
                    format: 'armored',
                }),
            ]);
            return { armoredData, armoredSignature };
        },

        async sign(data, signingKey, signatureContext) {
            const message = await openpgp.createMessage({ binary: data });
            const signature = await openpgp.sign({
                message,
                signingKeys: [signingKey],
                detached: true,
                format: 'binary',
                context: signatureContext ? { value: signatureContext, critical: true } : undefined,
            });
            return { signature };
        },

        async signArmored(data, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const signature = await openpgp.sign({
                message,
                signingKeys: toArray(signingKey),
                detached: true,
                format: 'armored',
            });
            return { signature };
        },

        async verify(data, signature, verificationKeys) {
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
                    verificationErrors: [error],
                };
            }
        },

        async verifyArmored(data, armoredSignature, verificationKeys, signatureContext) {
            try {
                const message = await openpgp.createMessage({ binary: data });
                const signature = await openpgp.readSignature({ armoredSignature });
                const result = await openpgp.verify({
                    message,
                    signature,
                    verificationKeys: toArray(verificationKeys),
                    context: signatureContext ? { value: signatureContext, required: true } : undefined,
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
                    verificationErrors: [error],
                };
            }
        },

        async decryptSessionKey(data, decryptionKeys) {
            const message = await openpgp.readMessage({ binaryMessage: data });
            const result = await openpgp.decryptSessionKeys({
                message,
                decryptionKeys: toArray(decryptionKeys),
            });
            return result[0];
        },

        async decryptArmoredSessionKey(armoredData, decryptionKeys) {
            const message = await openpgp.readMessage({ armoredMessage: armoredData });
            const result = await openpgp.decryptSessionKeys({
                message,
                decryptionKeys: toArray(decryptionKeys),
            });
            return result[0];
        },

        async decryptKey(armoredKey, passphrase) {
            const privateKey = await openpgp.readPrivateKey({ armoredKey });
            return await openpgp.decryptKey({ privateKey, passphrase });
        },

        async decryptAndVerify(data, sessionKey, verificationKeys) {
            try {
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

                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },

        async decryptAndVerifyDetached(data, signature, sessionKey, verificationKeys) {
            try {
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
                        message: await openpgp.createMessage({ binary: result.data }),
                        signature: sig,
                        verificationKeys: toArray(verificationKeys),
                    });
                    const sigVerified = await verifyResult.signatures[0]?.verified.catch(() => false);
                    verified = sigVerified
                        ? VERIFICATION_STATUS.SIGNED_AND_VALID
                        : VERIFICATION_STATUS.SIGNED_AND_INVALID;
                }

                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },

        async decryptArmored(armoredData, decryptionKeys) {
            const message = await openpgp.readMessage({ armoredMessage: armoredData });
            const result = await openpgp.decrypt({
                message,
                decryptionKeys: toArray(decryptionKeys),
                format: 'binary',
            });
            return result.data;
        },

        async decryptArmoredAndVerify(armoredData, decryptionKeys, verificationKeys) {
            try {
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

                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },

        async decryptArmoredAndVerifyDetached(armoredData, armoredSignature, sessionKey, verificationKeys) {
            try {
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
                        message: await openpgp.createMessage({ binary: result.data }),
                        signature,
                        verificationKeys: toArray(verificationKeys),
                    });
                    const sigVerified = await verifyResult.signatures[0]?.verified.catch(() => false);
                    verified = sigVerified
                        ? VERIFICATION_STATUS.SIGNED_AND_VALID
                        : VERIFICATION_STATUS.SIGNED_AND_INVALID;
                }

                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },

        async decryptArmoredWithPassword(armoredData, password) {
            const message = await openpgp.readMessage({ armoredMessage: armoredData });
            const result = await openpgp.decrypt({
                message,
                passwords: [password],
                format: 'binary',
            });
            return result.data;
        },
    };
}

/**
 * Initialize crypto (openpgp configuration)
 */
export async function initCrypto() {
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
