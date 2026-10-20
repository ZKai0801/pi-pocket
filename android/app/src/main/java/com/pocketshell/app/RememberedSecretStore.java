package com.pocketshell.app;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Remembered SSH passphrases and passwords, sealed at rest in their own
 * Keystore-protected store. This is deliberately separate from
 * {@link CredentialHandleVault}: that vault keeps encrypted key files and
 * public metadata, and its contract is not widened to hold passphrases.
 *
 * <p>The only values returned are per-call {@code char[]}s; a missing,
 * malformed or undecryptable id resolves to {@code null} so the caller prompts
 * instead of dialling with an empty secret (Review Focus 1). Errors never
 * carry secret material and nothing is logged (Review Focus 4).
 */
@SuppressWarnings("deprecation") // security-crypto 1.1.0 deprecates the helper; it remains the at-rest store used here.
public final class RememberedSecretStore {
    private static final String PREFERENCES_NAME = "pocketshell_remembered_secrets_v1";
    private static final Pattern SECRET_ID = Pattern.compile("[0-9a-fA-F-]{36}");
    private static final int MAX_SECRET_BYTES = 64 * 1024;
    private static final int MAX_STORED_BYTES = 96 * 1024;
    private static final int GCM_NONCE_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    /** One file per id in the JVM-test directory; used only by {@link #forTesting}. */
    static final String SECRET_SUFFIX = ".secret";

    interface KeyProtector {
        byte[] seal(byte[] plaintext) throws Exception;
        byte[] open(byte[] ciphertext) throws Exception;
    }

    interface SecretRepository {
        /** Raw sealed bytes, or null when the id has no record. */
        byte[] read(String secretId) throws IOException;
        void write(String secretId, byte[] sealed) throws IOException;
        /** True only when a record was removed. */
        boolean delete(String secretId) throws IOException;
    }

    private final SecretRepository repository;
    private final KeyProtector protector;

    public static RememberedSecretStore forContext(Context context) throws IOException {
        Context app = context.getApplicationContext();
        return new RememberedSecretStore(app.getFilesDir(), new AndroidSecretRepository(app), new AndroidKeyProtector());
    }

    RememberedSecretStore(File directory, SecretRepository repository, KeyProtector protector) throws IOException {
        if (directory == null || !directory.isDirectory()) {
            throw new IOException("Secure secret storage is unavailable.");
        }
        this.repository = repository;
        this.protector = protector;
    }

    /** JVM-test seam: file-backed storage plus an identity protector, never reachable from app code. */
    static RememberedSecretStore forTesting(File directory) throws IOException {
        return forTesting(directory, new IdentityProtector());
    }

    /** JVM-test seam: file-backed storage with an injectable protector. */
    static RememberedSecretStore forTesting(File directory, KeyProtector protector) throws IOException {
        return forTesting(directory, new FileSecretRepository(directory), protector);
    }

    /** JVM-test seam: inject both the storage and the protector so both failure modes are exercised. */
    static RememberedSecretStore forTesting(File directory, SecretRepository repository, KeyProtector protector)
        throws IOException {
        if ((!directory.exists() && !directory.mkdirs()) || !directory.isDirectory()) {
            throw new IOException("Secure secret storage is unavailable.");
        }
        return new RememberedSecretStore(directory, repository, protector);
    }

    /**
     * Seal a secret and return the id it is stored under. A blank id mints a
     * UUID; an existing id is replaced. The caller's array is wiped before
     * this method returns.
     */
    public synchronized String put(String secretId, char[] secret) throws IOException {
        if (secret == null || secret.length == 0) {
            if (secret != null) Arrays.fill(secret, '\0');
            throw new IOException("A secret is required.");
        }
        String id;
        if (secretId == null || secretId.trim().isEmpty()) {
            id = UUID.randomUUID().toString();
        } else if (isValidSecretId(secretId)) {
            id = secretId;
        } else {
            Arrays.fill(secret, '\0');
            throw new IOException("The remembered secret id is malformed.");
        }
        char[] owned = secret.clone();
        byte[] plaintext = null;
        byte[] sealed = null;
        try {
            plaintext = utf8Bytes(owned);
            if (plaintext.length > MAX_SECRET_BYTES) throw new IOException("The secret is too large to remember.");
            sealed = protector.seal(plaintext);
            if (sealed == null || sealed.length == 0) throw new IOException("The secret could not be stored safely.");
            repository.write(id, sealed);
            return id;
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw new IOException("The secret could not be stored safely.");
        } finally {
            Arrays.fill(secret, '\0');
            Arrays.fill(owned, '\0');
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (sealed != null) Arrays.fill(sealed, (byte) 0);
        }
    }

    /**
     * The plaintext secret, or null for an unknown, blank, malformed or
     * undecryptable id. Never throws for any of those (Review Focus 1).
     */
    public synchronized char[] resolve(String secretId) {
        if (!isValidSecretId(secretId)) return null;
        byte[] sealed = null;
        byte[] plaintext = null;
        try {
            sealed = repository.read(secretId);
            if (sealed == null) return null;
            plaintext = protector.open(sealed);
            if (plaintext == null || plaintext.length == 0) return null;
            char[] value = utf8Chars(plaintext);
            return value.length == 0 ? null : value;
        } catch (Exception unreadable) {
            return null;
        } finally {
            if (sealed != null) Arrays.fill(sealed, (byte) 0);
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    /**
     * True only when this call removed a record; repeats are a no-op. A write
     * that fails surfaces as {@link IOException} rather than reading as
     * "already gone", so an orphaned secret is never silently left behind.
     */
    public synchronized boolean delete(String secretId) throws IOException {
        if (!isValidSecretId(secretId)) return false;
        return repository.delete(secretId);
    }

    static boolean isValidSecretId(String secretId) {
        return secretId != null && SECRET_ID.matcher(secretId).matches();
    }

    private static byte[] utf8Bytes(char[] value) throws IOException {
        try {
            ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder().encode(CharBuffer.wrap(value));
            byte[] bytes = new byte[encoded.remaining()];
            encoded.get(bytes);
            if (encoded.hasArray()) Arrays.fill(encoded.array(), (byte) 0);
            return bytes;
        } catch (CharacterCodingException error) {
            throw new IOException("The secret could not be stored safely.");
        }
    }

    private static char[] utf8Chars(byte[] value) throws IOException {
        try {
            CharBuffer decoded = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(value));
            char[] chars = new char[decoded.remaining()];
            decoded.get(chars);
            if (decoded.hasArray()) Arrays.fill(decoded.array(), '\0');
            return chars;
        } catch (CharacterCodingException error) {
            throw new IOException("The remembered secret could not be read safely.");
        }
    }

    /** EncryptedSharedPreferences in its own file: Android's at-rest record for the app. */
    private static final class AndroidSecretRepository implements SecretRepository {
        private final Context context;
        private SharedPreferences preferences;

        AndroidSecretRepository(Context context) {
            this.context = context;
        }

        @Override public synchronized byte[] read(String secretId) throws IOException {
            SharedPreferences existing = preferences(false);
            if (existing == null) return null;
            String stored = existing.getString(secretId, null);
            if (stored == null) return null;
            try {
                return Base64.getDecoder().decode(stored);
            } catch (IllegalArgumentException error) {
                return null;
            }
        }

        @Override public synchronized void write(String secretId, byte[] sealed) throws IOException {
            String value = Base64.getEncoder().encodeToString(sealed);
            if (!preferences(true).edit().putString(secretId, value).commit()) {
                throw new IOException("The remembered secret could not be saved.");
            }
        }

        @Override public synchronized boolean delete(String secretId) throws IOException {
            SharedPreferences existing = preferences(false);
            if (existing == null || !existing.contains(secretId)) return false;
            if (!existing.edit().remove(secretId).commit()) {
                throw new IOException("The remembered secret could not be forgotten.");
            }
            return true;
        }

        /**
         * Read-only calls never create the file. A keyset the Keystore can no
         * longer open (restored backup, wiped key) is treated as absent, and
         * only a write recreates it.
         */
        private SharedPreferences preferences(boolean create) throws IOException {
            if (preferences != null) return preferences;
            if (!create && !recordFile().exists()) return null;
            try {
                preferences = open();
            } catch (Exception unreadable) {
                context.deleteSharedPreferences(PREFERENCES_NAME);
                if (!create) return null;
                try {
                    preferences = open();
                } catch (Exception error) {
                    throw new IOException("Remembered secret storage is unavailable.");
                }
            }
            return preferences;
        }

        private File recordFile() {
            return new File(new File(context.getApplicationInfo().dataDir, "shared_prefs"), PREFERENCES_NAME + ".xml");
        }

        private SharedPreferences open() throws Exception {
            MasterKey masterKey = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            return EncryptedSharedPreferences.create(
                    context,
                    PREFERENCES_NAME,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        }
    }

    /** JVM-test backing: one Base64-encoded sealed record per file in the test directory. */
    private static final class FileSecretRepository implements SecretRepository {
        private final File directory;

        FileSecretRepository(File directory) {
            this.directory = directory;
        }

        @Override public byte[] read(String secretId) throws IOException {
            File file = fileFor(secretId);
            if (!file.isFile() || file.length() > MAX_STORED_BYTES) return null;
            byte[] stored = readBounded(file, MAX_STORED_BYTES);
            try {
                return Base64.getDecoder().decode(stored);
            } catch (IllegalArgumentException error) {
                return null;
            } finally {
                Arrays.fill(stored, (byte) 0);
            }
        }

        @Override public void write(String secretId, byte[] sealed) throws IOException {
            byte[] stored = Base64.getEncoder().encode(sealed);
            File pending = new File(directory, "." + secretId + ".pending");
            File target = fileFor(secretId);
            try (FileOutputStream output = new FileOutputStream(pending)) {
                output.write(stored);
                output.getFD().sync();
            } finally {
                Arrays.fill(stored, (byte) 0);
            }
            try {
                // File.renameTo does not replace an existing target on every
                // filesystem; a second put must overwrite the old record.
                Files.move(pending.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException error) {
                pending.delete();
                throw new IOException("The secret could not be stored safely.");
            }
        }

        @Override public boolean delete(String secretId) {
            File file = fileFor(secretId);
            return file.isFile() && file.delete();
        }

        private File fileFor(String secretId) {
            return new File(directory, secretId + SECRET_SUFFIX);
        }
    }

    private static byte[] readBounded(File file, int maximumBytes) throws IOException {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            try {
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (output.size() + count > maximumBytes) throw new IOException("Stored secret is too large.");
                    output.write(buffer, 0, count);
                }
            } finally {
                Arrays.fill(buffer, (byte) 0);
            }
            return output.toByteArray();
        }
    }

    /**
     * The app's Keystore sealing, same AES-256-GCM scheme as
     * {@link CredentialHandleVault} but under its own alias so this store
     * shares no key with the SSH key vault.
     */
    private static final class AndroidKeyProtector implements KeyProtector {
        private static final String KEY_ALIAS = "pocketshell.remembered-secrets.v1";

        private SecretKey key() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
            KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
            android.security.keystore.KeyGenParameterSpec spec = new android.security.keystore.KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build();
            generator.init(spec);
            return generator.generateKey();
        }

        @Override public byte[] seal(byte[] plaintext) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] nonce = cipher.getIV();
            byte[] encrypted = cipher.doFinal(plaintext);
            byte[] output = new byte[nonce.length + encrypted.length];
            System.arraycopy(nonce, 0, output, 0, nonce.length);
            System.arraycopy(encrypted, 0, output, nonce.length, encrypted.length);
            Arrays.fill(encrypted, (byte) 0);
            return output;
        }

        @Override public byte[] open(byte[] ciphertext) throws Exception {
            if (ciphertext.length <= GCM_NONCE_BYTES) throw new IOException("Stored secret ciphertext is malformed.");
            byte[] nonce = Arrays.copyOfRange(ciphertext, 0, GCM_NONCE_BYTES);
            byte[] encrypted = Arrays.copyOfRange(ciphertext, GCM_NONCE_BYTES, ciphertext.length);
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, nonce));
                return cipher.doFinal(encrypted);
            } finally {
                Arrays.fill(nonce, (byte) 0);
                Arrays.fill(encrypted, (byte) 0);
            }
        }
    }

    /** Reachable only through {@link #forTesting}; makes the JVM tests Android-free. */
    private static final class IdentityProtector implements KeyProtector {
        @Override public byte[] seal(byte[] plaintext) {
            return plaintext.clone();
        }

        @Override public byte[] open(byte[] ciphertext) {
            return ciphertext.clone();
        }
    }
}
