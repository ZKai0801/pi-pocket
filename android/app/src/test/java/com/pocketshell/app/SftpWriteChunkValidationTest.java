package com.pocketshell.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

import org.junit.Test;

/**
 * The arithmetic rules of {@code SshCapabilityPlugin.validateStreamChunk}.
 *
 * These are the bounds the stateless streaming write relies on to stay safe
 * without a native handle: a chunk may never be empty, never exceed the
 * per-bridge-call ceiling, never start outside the declared file, and never
 * run past its end. Everything else in the write path needs a live SFTP
 * channel and belongs in a device or Docker journey, not here.
 */
public final class SftpWriteChunkValidationTest {
    private static final int CHUNK = 256 * 1024;
    private static final int STREAM = 64 * 1024 * 1024;

    @Test
    public void acceptsAChunkThatEndsExactlyAtTheDeclaredSize() throws Exception {
        SshCapabilityPlugin.validateStreamChunk(0L, 1L, 1);
        SshCapabilityPlugin.validateStreamChunk(0L, CHUNK, CHUNK);
        SshCapabilityPlugin.validateStreamChunk(CHUNK, 2L * CHUNK, CHUNK);
        SshCapabilityPlugin.validateStreamChunk(STREAM - CHUNK, STREAM, CHUNK);
    }

    @Test
    public void rejectsAnEmptyChunk() {
        assertCode("INVALID_ARGUMENT", 0L, 10L, 0);
    }

    @Test
    public void rejectsAChunkPastThePerCallCeiling() {
        assertCode("INVALID_ARGUMENT", 0L, 2L * CHUNK, CHUNK + 1);
    }

    @Test
    public void rejectsAChunkThatRunsPastTheDeclaredSize() {
        assertCode("INVALID_ARGUMENT", 0L, CHUNK, CHUNK + 1);
        assertCode("INVALID_ARGUMENT", CHUNK, 2L * CHUNK - 1, CHUNK);
        assertCode("INVALID_ARGUMENT", 1L, 1L, 1);
    }

    @Test
    public void rejectsADeclaredSizeOutsideItsRange() {
        assertCode("INVALID_ARGUMENT", 0L, 0L, 1);
        assertCode("INVALID_ARGUMENT", 0L, -1L, 1);
        assertCode("INVALID_ARGUMENT", 0L, STREAM + 1L, 1);
    }

    @Test
    public void rejectsAnOffsetOutsideItsRange() {
        assertCode("INVALID_ARGUMENT", -1L, 10L, 1);
        assertCode("INVALID_ARGUMENT", STREAM + 1L, STREAM, 1);
    }

    private static void assertCode(String code, long offset, long totalBytes, int length) {
        try {
            SshCapabilityPlugin.validateStreamChunk(offset, totalBytes, length);
            fail("expected validateStreamChunk to reject offset=" + offset
                + " totalBytes=" + totalBytes + " length=" + length);
        } catch (SshCapabilityPlugin.PluginFailure failure) {
            assertNotNull(failure.getMessage());
            assertEquals(code, failure.code);
        }
    }
}
