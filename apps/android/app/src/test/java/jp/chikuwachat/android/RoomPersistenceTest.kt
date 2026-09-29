package jp.chikuwachat.android

import jp.chikuwachat.android.platform.RoomPersistence
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomPersistenceTest {
    /**
     * The local database opens with fallbackToDestructiveMigration, which is only acceptable for the first schema.
     * Whoever bumps the version must add a Migration to RoomPersistence.open (and hasChannel) and drop the fallback,
     * then update this test: otherwise every device loses its cached rows, drafts and unsent messages at the update.
     */
    @Test fun schemaVersionIsStillTheFirstOne() {
        assertEquals("bumping the Room schema needs a Migration instead of the destructive fallback", 1, RoomPersistence.SCHEMA_VERSION)
    }

    @Test fun databaseFilesAreNamedByAHashOfTheProfile() { // SYNC_PROTOCOL.md §11
        val a = RoomPersistence.fileName("http://a.example|alice")
        val b = RoomPersistence.fileName("http://a.example|alicia")
        assertTrue(a.startsWith("chikuwa-") && a.endsWith(".db"))
        assertNotEquals(a, b)
        assertEquals(a, RoomPersistence.fileName("http://a.example|alice"))
    }
}
