package jp.chikuwachat.android

import jp.chikuwachat.android.platform.RoomPersistence
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomPersistenceTest {
    /**
     * Every schema bump ships a Migration (no destructive fallback on upgrade: every device would lose its cached
     * rows, drafts and unsent messages at the update). The chain must run from the first schema to the current one.
     */
    @Test fun migrationsReachTheCurrentSchemaFromTheFirst() {
        assertEquals(2, RoomPersistence.SCHEMA_VERSION) // M74: the canvases table
        var at = 1
        RoomPersistence.MIGRATIONS.forEach { migration ->
            assertEquals("migrations must be contiguous", at, migration.startVersion)
            at = migration.endVersion
        }
        assertEquals(RoomPersistence.SCHEMA_VERSION, at)
    }

    @Test fun databaseFilesAreNamedByAHashOfTheProfile() { // SYNC_PROTOCOL.md §11
        val a = RoomPersistence.fileName("http://a.example|alice")
        val b = RoomPersistence.fileName("http://a.example|alicia")
        assertTrue(a.startsWith("chikuwa-") && a.endsWith(".db"))
        assertNotEquals(a, b)
        assertEquals(a, RoomPersistence.fileName("http://a.example|alice"))
    }
}
