package jp.chikuwachat.android.ui

import java.time.ZonedDateTime

/** Slash commands (M13b): a few Slack-style shortcuts that map onto existing actions, client-side only. */
object SlashCommands {
    data class Command(val name: String, val usage: String, val description: String, val channelOnly: Boolean = false)
    data class Parsed(val name: String, val args: String, val known: Boolean)

    val all = listOf(
        Command("status", "/status [絵文字] 文", "ステータスを設定 (/status clear で消す)"),
        Command("dnd", "/dnd 30m | 1h | 2h | 4h | tomorrow | off", "通知を一時停止"),
        Command("topic", "/topic 文", "チャンネルのトピックを変更", channelOnly = true),
        Command("invite", "/invite @名前 …", "メンバーを追加", channelOnly = true),
        Command("leave", "/leave", "チャンネルから退出", channelOnly = true),
        Command("join", "/join #チャンネル", "公開チャンネルに参加"),
        Command("dm", "/dm @名前", "ダイレクトメッセージを開く"),
        Command("mute", "/mute [1h | 8h | tomorrow]", "この会話の通知を止める"),
        Command("unmute", "/unmute", "この会話の通知を再開"),
        Command("me", "/me 文", "動作を斜体で投稿"),
        Command("shrug", "/shrug [文]", "¯\\_(ツ)_/¯ を添えて投稿"),
        Command("poll", "/poll 質問 | 選択肢 | 選択肢 …", "アンケートを作る (/poll だけでフォームを開く)"),
        Command(SCHEDULE, "/日程 [質問] 日付 日付 …", "日付を選択肢にした複数選択の投票 (/日程 だけでフォームを開く)"),
        Command("help", "/help", "コマンド一覧"),
    )

    /** M30: the date poll (ui/Templates.kt parseSchedule). */
    const val SCHEDULE = "日程"

    /** In a code span, so the underscores do not read as italics (the light markdown has no escapes). */
    const val SHRUG = "`¯\\_(ツ)_/¯`"

    // M30: a name is letters of any script, digits, `_` or `-` (`/日程`, a template's `/日報`), like the server's template names.
    private val PATTERN = Regex("""^/([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$""")
    private val PREFIX = Regex("""^/([\p{L}\p{N}_-]*)$""")
    private val DURATION = Regex("""^(\d{1,3})\s*(m|min|h|hour|hours|d|day|days)$""")
    private val SHORTCODE = Regex("""^:[a-z0-9_+-]+:$""")
    private val EMOJI_TOKEN = Regex("""^(?:[\p{So}]|[\uD83C-\uDBFF][\uDC00-\uDFFF])(?:[️‍]|[\p{So}]|[\uD83C-\uDBFF][\uDC00-\uDFFF])*$""")

    /**
     * `/name args` at the start of the text; null when the text is not a command at all. `known` is a built-in one; any
     * other name may still be a template's (Templates.find).
     */
    fun parse(text: String): Parsed? {
        val match = PATTERN.find(text.trim()) ?: return null
        val name = match.groupValues[1].lowercase()
        return Parsed(name, match.groupValues[2].trim(), all.any { it.name == name })
    }

    /** The name typed so far after a leading `/` (`/` → ""); null once a space follows or the text is not a command. */
    fun prefix(text: String): String? = PREFIX.find(text)?.groupValues?.get(1)?.lowercase()

    /** Commands whose name starts with what was typed (`/`, `/st` …); empty once a space follows. */
    fun candidates(text: String): List<Command> {
        val prefix = prefix(text) ?: return emptyList()
        return all.filter { it.name.startsWith(prefix) }
    }

    fun tomorrowMorning(now: ZonedDateTime = ZonedDateTime.now()): ZonedDateTime =
        now.plusDays(1).withHour(8).withMinute(0).withSecond(0).withNano(0)

    /** `30m`, `1h`, `2d`, `tomorrow` (08:00) → when a pause ends; null for anything else. */
    fun duration(arg: String, now: ZonedDateTime = ZonedDateTime.now()): ZonedDateTime? {
        val word = arg.trim().lowercase()
        if (word == "tomorrow" || word == "明日") return tomorrowMorning(now)
        val match = DURATION.find(word) ?: return null
        val amount = match.groupValues[1].toLong()
        return when (match.groupValues[2][0]) {
            'm' -> now.plusMinutes(amount)
            'h' -> now.plusHours(amount)
            else -> now.plusDays(amount)
        }
    }

    /** The optional leading emoji (a glyph or `:shortcode:`) and the text of `/status`. */
    fun splitStatus(args: String): Pair<String?, String> {
        val trimmed = args.trim()
        val token = trimmed.substringBefore(' ')
        val rest = trimmed.removePrefix(token).trim()
        return when {
            SHORTCODE.matches(token) -> Emoji.replaceShortcodes(token) to rest
            EMOJI_TOKEN.matches(token) -> token to rest
            else -> null to trimmed
        }
    }
}
