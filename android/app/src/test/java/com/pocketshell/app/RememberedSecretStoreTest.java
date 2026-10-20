package com.pocketshell.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import java.util.UUID;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public final class RememberedSecretStoreTest {
    private File directory;
    private RememberedSecretStore store;

    @Before public void setUp() throws Exception {
        directory = Files.createTempDirectory("pocketshell-remembered-secrets-test").toFile();
        store = RememberedSecretStore.forTesting(directory);
    }

    @After public void tearDown() {
        erase(directory);
    }

    @Test public void roundTripsASecret() throws Exception {
        char[] secret = "hunter2".toCharArray();
        String id = store.put(null, secret);
        assertArrayEquals("hunter2".toCharArray(), store.resolve(id));
    }

    @Test public void deletingMakesItUnresolvable() throws Exception {
        String id = store.put(null, "x".toCharArray());
        assertTrue(store.delete(id));
        assertNull(store.resolve(id));
    }

    @Test public void anUnknownIdIsNullNotAnException() throws Exception {
        assertNull(store.resolve("no-such-id"));
        assertNull(store.resolve(""));
        assertNull(store.resolve(null));
    }

    @Test public void deleteTwiceIsFalseTheSecondTime() throws Exception {
        String id = store.put(null, "x".toCharArray());
        assertTrue(store.delete(id));
        assertFalse(store.delete(id));
    }

    @Test public void aSecondPutOnTheSameIdReplacesIt() throws Exception {
        String id = store.put(null, "first".toCharArray());
        assertEquals(id, store.put(id, "second".toCharArray()));
        assertArrayEquals("second".toCharArray(), store.resolve(id));
    }

    @Test public void aBlankIdMintsOne() throws Exception {
        String id = store.put("   ", "x".toCharArray());
        assertTrue(RememberedSecretStore.isValidSecretId(id));
        assertArrayEquals("x".toCharArray(), store.resolve(id));
    }

    @Test public void putWipesTheCallersCopy() throws Exception {
        char[] secret = "hunter2".toCharArray();
        String id = store.put(null, secret);
        assertArrayEquals(new char[secret.length], secret);
        assertNotNull(store.resolve(id));
    }

    @Test public void putRefusesAnEmptySecret() throws Exception {
        try {
            store.put(null, new char[0]);
            fail("An empty secret must not be stored.");
        } catch (IOException expected) {
            assertFalse(expected.getMessage() == null || expected.getMessage().isEmpty());
        }
        try {
            store.put(null, null);
            fail("A null secret must not be stored.");
        } catch (IOException expected) {
            assertFalse(expected.getMessage() == null || expected.getMessage().isEmpty());
        }
    }

    @Test public void aSecretIsNotReadableFromTheBackingFileAsPlaintext() throws Exception {
        store.put(null, "hunter2".toCharArray());
        File[] records = directory.listFiles();
        assertNotNull(records);
        assertEquals(1, records.length);
        for (File record : records) {
            String contents = new String(Files.readAllBytes(record.toPath()), StandardCharsets.ISO_8859_1);
            assertFalse(record.getName(), contents.contains("hunter2"));
        }
    }

    @Test public void aCorruptRecordResolvesToNullInsteadOfThrowing() throws Exception {
        String id = UUID.randomUUID().toString();
        byte[] invalidUtf8 = new byte[] {(byte) 0xC3, (byte) 0x28};
        Files.write(
            new File(directory, id + RememberedSecretStore.SECRET_SUFFIX).toPath(),
            Base64.getEncoder().encode(invalidUtf8)
        );
        assertNull(store.resolve(id));
    }

    @Test public void anUndecryptableRecordResolvesToNull() throws Exception {
        RememberedSecretStore sealed = RememberedSecretStore.forTesting(directory, new SealOnlyProtector());
        String id = sealed.put(null, "hunter2".toCharArray());
        assertNull(sealed.resolve(id));
    }

    @Test public void aFailedWriteThrowsAndLeavesNoRecord() throws Exception {
        FailingRepository repository = new FailingRepository();
        RememberedSecretStore failing = RememberedSecretStore.forTesting(directory, repository, new PassThroughProtector());
        try {
            failing.put(null, "hunter2".toCharArray());
            fail("A failed write must not be reported as success.");
        } catch (IOException expected) {
            assertFalse(expected.getMessage() == null || expected.getMessage().isEmpty());
        }
        assertEquals(1, repository.writes);
        assertEquals(0, directory.listFiles().length);
    }

    @Test public void anInvalidIdIsRefusedAndTheCallersCopyIsWiped() throws Exception {
        char[] secret = "hunter2".toCharArray();
        try {
            store.put("not-a-uuid", secret);
            fail("A malformed id must not be stored.");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().toLowerCase().contains("id"));
        }
        assertArrayEquals(new char[secret.length], secret);
    }

    @Test public void aTraversalShapedIdIsRefusedByPutAndResolve() throws Exception {
        char[] secret = "hunter2".toCharArray();
        try {
            store.put("../../x", secret);
            fail("A traversal-shaped id must not be stored.");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().toLowerCase().contains("id"));
        }
        assertArrayEquals(new char[secret.length], secret);
        assertNull(store.resolve("../../x"));
    }

    @Test public void aFailedDeleteSurfacesInsteadOfReadingAsAlreadyGone() throws Exception {
        // forgetSecret catches Exception, so this throw reaches its reject path.
        FailingRepository repository = new FailingRepository();
        RememberedSecretStore failing = RememberedSecretStore.forTesting(directory, repository, new PassThroughProtector());
        try {
            failing.delete(UUID.randomUUID().toString());
            fail("A failed commit must not read as 'already gone'.");
        } catch (IOException expected) {
            assertFalse(expected.getMessage() == null || expected.getMessage().isEmpty());
        }
        assertEquals(1, repository.deletes);
        assertFalse(failing.delete("not-a-uuid"));
        assertEquals(1, repository.deletes);
    }

    private static void erase(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) erase(child);
        file.delete();
    }

    private static final class SealOnlyProtector implements RememberedSecretStore.KeyProtector {
        @Override public byte[] seal(byte[] plaintext) {
            return plaintext.clone();
        }

        @Override public byte[] open(byte[] ciphertext) throws IOException {
            throw new IOException("injected unreadable record");
        }
    }

    private static final class PassThroughProtector implements RememberedSecretStore.KeyProtector {
        @Override public byte[] seal(byte[] plaintext) {
            return plaintext.clone();
        }

        @Override public byte[] open(byte[] ciphertext) {
            return ciphertext.clone();
        }
    }

    private static final class FailingRepository implements RememberedSecretStore.SecretRepository {
        int writes;
        int deletes;

        @Override public byte[] read(String secretId) {
            return null;
        }

        @Override public void write(String secretId, byte[] sealed) throws IOException {
            writes++;
            throw new IOException("injected write failure");
        }

        @Override public boolean delete(String secretId) throws IOException {
            deletes++;
            throw new IOException("injected delete failure");
        }
    }
}
