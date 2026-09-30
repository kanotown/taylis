package jp.chikuwachat.android

import jp.chikuwachat.android.api.DeviceOut
import jp.chikuwachat.android.api.QuietHours
import jp.chikuwachat.android.api.SessionOut
import jp.chikuwachat.android.ui.Appearance
import jp.chikuwachat.android.ui.BrandPalette
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.PauseChoice
import jp.chikuwachat.android.ui.PostGrouping
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SettingsPage
import jp.chikuwachat.android.ui.YouSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/** M40 (MOBILE_UI.md §6.5): the 自分 tab's pure parts, its routes, and the brand colour's contrast. */
class YouTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val now = ZonedDateTime.of(2026, 9, 30, 15, 0, 0, 0, tokyo)
    private val you = listOf<Route>(Route.You)

    // --- 通知を一時停止 ---

    @Test fun thePauseOffersResumeOnlyWhilePaused() {
        assertEquals(
            listOf("30 分", "1 時間", "2 時間", "明日 8:00", "日時を指定"),
            YouSettings.pauseChoices(paused = false).map { it.label },
        )
        assertEquals(PauseChoice.entries, YouSettings.pauseChoices(paused = true))
        assertEquals(PauseChoice.RESUME, YouSettings.pauseChoices(paused = true).last())
    }

    @Test fun eachPauseChoiceSendsItsDndUntil() {
        assertEquals("2026-09-30T06:30:00Z", YouSettings.dndUntil(PauseChoice.MINUTES_30, now))
        assertEquals("2026-09-30T07:00:00Z", YouSettings.dndUntil(PauseChoice.HOUR_1, now))
        assertEquals("2026-09-30T08:00:00Z", YouSettings.dndUntil(PauseChoice.HOURS_2, now))
        // 明日 8:00 in my zone.
        assertEquals("2026-09-30T23:00:00Z", YouSettings.dndUntil(PauseChoice.TOMORROW_8, now))
        val picked = ZonedDateTime.of(2026, 10, 2, 9, 30, 0, 0, tokyo)
        assertEquals("2026-10-02T00:30:00Z", YouSettings.dndUntil(PauseChoice.CUSTOM, now, picked))
        assertNull(YouSettings.dndUntil(PauseChoice.RESUME, now)) // 再開 clears it
    }

    @Test(expected = IllegalArgumentException::class)
    fun aCustomPauseNeedsItsPickedTime() {
        YouSettings.dndUntil(PauseChoice.CUSTOM, now, picked = null)
    }

    @Test fun aCustomPauseEndsAtLeastAMinuteAhead() {
        assertFalse(YouSettings.customPauseValid(null, now))
        assertFalse(YouSettings.customPauseValid(now.plusSeconds(30), now))
        assertTrue(YouSettings.customPauseValid(now.plusMinutes(5), now))
    }

    @Test fun thePauseRowSaysOffOrUntilWhen() {
        val at = now.toInstant()
        assertEquals("オフ", YouSettings.pauseSummary(null, at, tokyo))
        assertEquals("オフ", YouSettings.pauseSummary("2026-09-30T05:00:00Z", at, tokyo)) // ended
        assertEquals("オフ", YouSettings.pauseSummary("not a time", at, tokyo))
        assertEquals("16:30 まで", YouSettings.pauseSummary("2026-09-30T07:30:00Z", at, tokyo))
        assertEquals("16:30 まで", YouSettings.pauseSummary("2026-09-30T16:30:00+09:00", at, tokyo)) // with an offset
        assertEquals("明日 08:00 まで", YouSettings.pauseSummary("2026-09-30T23:00:00Z", at, tokyo))
        assertEquals("10/2 09:30 まで", YouSettings.pauseSummary("2026-10-02T00:30:00Z", at, tokyo))
        assertTrue(YouSettings.paused("2026-09-30T07:30:00Z", at))
        assertFalse(YouSettings.paused("2026-09-30T05:00:00Z", at))
        assertFalse(YouSettings.paused(null, at))
    }

    // --- おやすみ時間 ---

    @Test fun theQuietHoursRowSaysItsWindowOrOff() {
        assertEquals("オフ", YouSettings.quietSummary(null))
        assertEquals("22:00〜07:00", YouSettings.quietSummary(QuietHours("22:00", "07:00", (0..6).toList(), "Asia/Tokyo")))
        assertEquals("22:00〜07:00", YouSettings.quietSummary(QuietHours("22:00", "07:00", emptyList(), "Asia/Tokyo")))
        assertEquals("23:00〜06:30 (月火水木金)", YouSettings.quietSummary(QuietHours("23:00", "06:30", listOf(4, 0, 1, 2, 3), "Asia/Tokyo")))
    }

    @Test fun theQuietHoursFormSaysWhyItCannotBeSaved() {
        val all = (0..6).toSet()
        assertNull(YouSettings.quietHoursProblem(on = false, start = "", end = "", days = emptySet())) // off: nothing to check
        assertNull(YouSettings.quietHoursProblem(on = true, start = "22:00", end = "07:00", days = all))
        assertEquals("時刻は HH:mm で指定してください", YouSettings.quietHoursProblem(true, "24:00", "07:00", all))
        assertEquals("開始と終了を別の時刻にしてください", YouSettings.quietHoursProblem(true, "07:00", "07:00", all))
        assertEquals("曜日を 1 つ以上選んでください", YouSettings.quietHoursProblem(true, "22:00", "07:00", emptySet()))
    }

    @Test fun theQuietHoursFormKnowsWhenItChanged() {
        val saved = QuietHours("22:00", "07:00", listOf(0, 1, 2, 3, 4, 5, 6), "Asia/Tokyo")
        val same = YouSettings.quietHours(true, "22:00", "07:00", setOf(6, 5, 4, 3, 2, 1, 0), "Asia/Tokyo")
        assertEquals(listOf(0, 1, 2, 3, 4, 5, 6), same!!.days) // sent in order
        assertFalse(YouSettings.quietHoursChanged(saved, same))
        assertFalse(YouSettings.quietHoursChanged(saved.copy(days = emptyList()), same)) // no days = every day
        assertTrue(YouSettings.quietHoursChanged(saved, same.copy(end = "06:00")))
        assertTrue(YouSettings.quietHoursChanged(saved, same.copy(tz = "Europe/London")))
        assertTrue(YouSettings.quietHoursChanged(saved, YouSettings.quietHours(false, "22:00", "07:00", emptySet(), "Asia/Tokyo")))
        assertTrue(YouSettings.quietHoursChanged(null, same))
        assertFalse(YouSettings.quietHoursChanged(null, null))
    }

    // --- ログイン中の端末 ---

    private fun session(id: String, lastUsed: String, current: Boolean = false, platform: String = "android", name: String? = "Pixel 9") =
        SessionOut(
            id = id,
            device = DeviceOut(id = "d-$id", platform = platform, deviceName = name, enabled = true, createdAt = "2026-09-01T00:00:00Z", updatedAt = "2026-09-01T00:00:00Z"),
            current = current,
            createdAt = "2026-09-01T00:00:00Z",
            lastUsedAt = lastUsed,
            expiresAt = "2026-10-30T00:00:00Z",
        )

    @Test fun thisDeviceComesFirstThenTheMostRecentlyUsed() {
        val sessions = listOf(
            session("old", "2026-09-20T00:00:00Z"),
            session("me", "2026-09-29T00:00:00Z", current = true),
            session("new", "2026-09-30T05:00:00+00:00"),
            session("mid", "2026-09-30T03:00:00Z"),
        )
        assertEquals(listOf("me", "new", "mid", "old"), YouSettings.orderedSessions(sessions).map { it.id })
        assertFalse(YouSettings.canSignOut(sessions[1])) // this one signs out with 「ログアウト」
        assertTrue(YouSettings.canSignOut(sessions[0]))
    }

    @Test fun aDeviceIsNamedByItsNameElseItsPlatform() {
        assertEquals("Pixel 9", YouSettings.deviceLabel(session("a", "2026-09-30T00:00:00Z")))
        assertEquals("iPhone / iPad", YouSettings.deviceLabel(session("b", "2026-09-30T00:00:00Z", platform = "ios", name = null)))
        assertEquals("デスクトップ", YouSettings.deviceLabel(session("c", "2026-09-30T00:00:00Z", platform = "desktop", name = " ")))
        assertEquals("Web ブラウザ", YouSettings.deviceLabel(session("d", "2026-09-30T00:00:00Z", platform = "web", name = null)))
    }

    @Test fun lastUsedReadsLikeAClock() {
        val at = now.toInstant() // 15:00 JST
        assertEquals("たった今", YouSettings.lastUsedLabel("2026-09-30T05:59:40Z", at, tokyo))
        assertEquals("5 分前", YouSettings.lastUsedLabel("2026-09-30T05:55:00Z", at, tokyo))
        assertEquals("今日 09:05", YouSettings.lastUsedLabel("2026-09-30T00:05:00Z", at, tokyo))
        assertEquals("昨日 21:40", YouSettings.lastUsedLabel("2026-09-29T12:40:00Z", at, tokyo))
        assertEquals("9月2日", YouSettings.lastUsedLabel("2026-09-02T03:00:00Z", at, tokyo))
        assertEquals("2025年12月1日", YouSettings.lastUsedLabel("2025-12-01T03:00:00Z", at, tokyo))
        assertEquals("", YouSettings.lastUsedLabel(null, at, tokyo))
    }

    // --- the list and the routes ---

    @Test fun theListRowsAreInTheSpecsOrderWithAdminOnlyForAdmins() {
        assertEquals(
            listOf(SettingsPage.NOTIFICATIONS, SettingsPage.APPEARANCE, SettingsPage.PROFILE, SettingsPage.ACCOUNT, SettingsPage.WORKSPACES),
            SettingsPage.listed(isAdmin = false),
        )
        assertEquals(SettingsPage.ADMIN, SettingsPage.listed(isAdmin = true).last())
        assertEquals("@yamada · M2", YouSettings.handle("yamada", " M2 "))
        assertEquals("@yamada", YouSettings.handle("yamada", ""))
        assertEquals("@yamada", YouSettings.handle("yamada", null))
    }

    @Test fun aRowPushesItsScreenAndBackReturnsToTheList() {
        val account = MainNav.openSettings(you, SettingsPage.ACCOUNT)
        assertEquals(listOf(Route.You, Route.Settings(SettingsPage.ACCOUNT)), account)
        assertEquals(SettingsPage.ACCOUNT, MainNav.settingsPage(account))
        assertEquals(account, MainNav.openSettings(account, SettingsPage.ACCOUNT)) // a second tap pushes nothing
        val password = MainNav.openSettings(account, SettingsPage.PASSWORD)
        assertEquals(SettingsPage.PASSWORD, MainNav.settingsPage(password))
        assertEquals(SettingsPage.ACCOUNT, MainNav.settingsRow(password)) // the row it came from
        assertEquals(account, MainNav.back(password))
        assertEquals(you, MainNav.back(account))
        assertNull(MainNav.settingsPage(you))
        assertNull(MainNav.settingsRow(you))
    }

    @Test fun wideARowReplacesTheScreenBesideTheList() {
        val password = MainNav.openSettings(MainNav.openSettings(you, SettingsPage.ACCOUNT), SettingsPage.PASSWORD)
        val notifications = MainNav.selectSettings(password, SettingsPage.NOTIFICATIONS)
        assertEquals(listOf(Route.You, Route.Settings(SettingsPage.NOTIFICATIONS)), notifications)
        assertEquals(SettingsPage.NOTIFICATIONS, MainNav.settingsRow(notifications))
        assertEquals(you, MainNav.back(notifications))
        assertFalse(YouSettings.twoPane(412f)) // a phone upright
        assertTrue(YouSettings.twoPane(600f))
        assertTrue(YouSettings.twoPane(915f)) // a phone on its side, a tablet
    }

    @Test fun theSettingsScreensSurviveARotationAndHideTheTabBar() {
        val stack = MainNav.openSettings(MainNav.openSettings(you, SettingsPage.ACCOUNT), SettingsPage.PASSWORD)
        assertEquals(stack, MainNav.decode(MainNav.encode(stack)))
        assertTrue(MainNav.valid(stack))
        assertTrue(MainTabs.barShown(you))
        assertFalse(MainTabs.barShown(stack))
        assertTrue(MainNav.canGoBack(stack))
    }

    @Test fun myProfileCardOpensTheStatusScreenOnTheYouTab() {
        val onHome = MainTabs.initial
        val opened = MainTabs.openSettings(onHome, SettingsPage.STATUS)
        assertEquals(MainTab.YOU, opened.selected)
        assertEquals(listOf(Route.You, Route.Settings(SettingsPage.STATUS)), MainTabs.stack(opened))
        // What the 自分 tab had open is replaced; back returns to its list, then home.
        val back = MainTabs.back(MainTabs.openSettings(opened, SettingsPage.QUIET_HOURS))
        assertEquals(you, MainTabs.stack(back))
        assertEquals(MainTab.HOME, MainTabs.back(back).selected)
    }

    // --- 表示 and the brand colour ---

    @Test fun theAppearanceIsKeptOnTheDevice() {
        val prefs = MemoryStore()
        assertEquals(Appearance.SYSTEM, Appearance.read(prefs))
        Appearance.write(prefs, Appearance.DARK)
        assertEquals(Appearance.DARK, Appearance.read(prefs))
        Appearance.write(prefs, Appearance.LIGHT)
        assertEquals(Appearance.LIGHT, Appearance.read(prefs))
        Appearance.write(prefs, Appearance.SYSTEM)
        assertNull(prefs.values["appearance"]) // the default leaves no key behind
        assertEquals(Appearance.SYSTEM, Appearance.read(MemoryStore(mapOf("appearance" to "sepia"))))
        assertTrue(Appearance.SYSTEM.isDark(systemDark = true))
        assertFalse(Appearance.LIGHT.isDark(systemDark = true))
        assertTrue(Appearance.DARK.isDark(systemDark = false))
    }

    @Test fun groupingPostsIsKeptOnTheDeviceAndOffByDefault() {
        val prefs = MemoryStore()
        assertFalse(PostGrouping.read(prefs))
        PostGrouping.write(prefs, true)
        assertTrue(PostGrouping.read(prefs))
        PostGrouping.write(prefs, false)
        assertFalse(PostGrouping.read(prefs))
        assertNull(prefs.values["group_posts"]) // off leaves no key behind
    }

    @Test fun theBrandIsThePrimaryColourInLight() {
        assertEquals(0xFF5B5BD6, BrandPalette.light.getValue("primary"))
        assertEquals(0xFF5B5BD6, BrandPalette.dark.getValue("primaryContainer"))
        assertEquals(BrandPalette.light.keys, BrandPalette.dark.keys)
    }

    @Test fun textOnEveryFilledRoleReadsInLightAndDark() {
        // WCAG AA for text (4.5:1): buttons, chips, badges, containers and the surfaces' own text.
        val textPairs = listOf(
            "primary" to "onPrimary", "primaryContainer" to "onPrimaryContainer",
            "secondary" to "onSecondary", "secondaryContainer" to "onSecondaryContainer",
            "tertiary" to "onTertiary", "tertiaryContainer" to "onTertiaryContainer",
            "error" to "onError", "errorContainer" to "onErrorContainer",
            "surface" to "onSurface", "surface" to "onSurfaceVariant", "background" to "onBackground",
            "surfaceContainerHigh" to "onSurface", "surfaceContainerHighest" to "onSurfaceVariant",
            "inverseSurface" to "inverseOnSurface",
            "surface" to "primary", "surface" to "error", // text buttons, the red ログアウト
        )
        for (dark in listOf(false, true)) {
            val p = BrandPalette.palette(dark)
            for ((back, fore) in textPairs) {
                val ratio = BrandPalette.contrast(p.getValue(back), p.getValue(fore))
                assertTrue("$fore on $back (dark=$dark) is ${"%.2f".format(ratio)}", ratio >= 4.5)
            }
            // Non-text parts (a switch's track, the unread dot, an outlined field) stand out 3:1 from the surface.
            for (part in listOf("primary", "outline")) {
                val ratio = BrandPalette.contrast(p.getValue("surface"), p.getValue(part))
                assertTrue("$part on surface (dark=$dark) is ${"%.2f".format(ratio)}", ratio >= 3.0)
            }
        }
        assertEquals(21.0, BrandPalette.contrast(0xFF000000, 0xFFFFFFFF), 0.01)
    }
}
