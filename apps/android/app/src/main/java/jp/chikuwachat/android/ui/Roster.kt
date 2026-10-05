package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.LabProfileOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * The lab roster (M23, DATA_MODEL.md lab_profiles): labels and the roster order, the same as the server's
 * (`GET /lab/roster`) and the other clients'. Names compare by code point, as on the server, so every client agrees.
 * An affiliation, rank or grade a newer server adds sorts after the known ones of its step.
 */
object Roster {
    val AFFILIATIONS get() = listOf("faculty" to L10n.str(R.string.roster_faculty), "student" to L10n.str(R.string.roster_student), "other" to L10n.str(R.string.common_other), "alumni" to L10n.str(R.string.roster_alumni))
    val RANKS get() = listOf("professor" to L10n.str(R.string.roster_professor), "associate_professor" to L10n.str(R.string.roster_associate_professor), "lecturer" to L10n.str(R.string.roster_lecturer), "assistant_professor" to L10n.str(R.string.roster_assistant_professor))
    /** Roster order: from D3 down to B3. */
    val GRADES = listOf("D3", "D2", "D1", "M2", "M1", "B4", "B3")
    /** The heading of the people off the roster, after everyone on it. */
    val OFF_ROSTER: String get() = L10n.str(R.string.roster_other_members)

    private val AFFILIATION_ORDER = AFFILIATIONS.map { it.first }
    private val RANK_ORDER = RANKS.map { it.first }

    private fun place(values: List<String>, value: String?): Int = values.indexOf(value).let { if (it < 0) values.size else it }

    private fun step(profile: LabProfileOut): Int = when (profile.affiliation) {
        "faculty" -> place(RANK_ORDER, profile.rank)
        "student" -> place(GRADES, profile.grade)
        else -> 0
    }

    /** Python's str order (the server's): by code point. String.compareTo goes by UTF-16 unit, which differs past U+FFFF. */
    fun compareCodePoints(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val ca = a.codePointAt(i)
            val cb = b.codePointAt(j)
            if (ca != cb) return ca.compareTo(cb)
            i += Character.charCount(ca)
            j += Character.charCount(cb)
        }
        return when {
            i < a.length -> 1
            j < b.length -> -1
            else -> 0
        }
    }

    /** Where a person sorts: on the roster by step then reading (or name) then username; off it after everyone on it. */
    fun compare(a: UserPublic, b: UserPublic, roster: Map<String, LabProfileOut>): Int {
        val pa = roster[a.id]
        val pb = roster[b.id]
        if (pa == null || pb == null) {
            return when {
                pa != null -> -1
                pb != null -> 1
                else -> compareCodePoints(a.displayName, b.displayName).takeIf { it != 0 } ?: compareCodePoints(a.username, b.username)
            }
        }
        val affiliation = place(AFFILIATION_ORDER, pa.affiliation) - place(AFFILIATION_ORDER, pb.affiliation)
        if (affiliation != 0) return affiliation
        val steps = step(pa) - step(pb)
        if (steps != 0) return steps
        val names = compareCodePoints(pa.reading?.ifEmpty { null } ?: a.displayName, pb.reading?.ifEmpty { null } ?: b.displayName)
        return if (names != 0) names else compareCodePoints(a.username, b.username)
    }

    /**
     * A member list's order: people on the roster first in roster order, then the others by the list's own order
     * (`offRoster`), as the desktop does. Still a total order, so sorting never trips over it.
     */
    fun listOrder(roster: Map<String, LabProfileOut>, offRoster: Comparator<UserPublic>): Comparator<UserPublic> =
        Comparator { a, b -> if (a.id in roster || b.id in roster) compare(a, b, roster) else offRoster.compare(a, b) }

    /** The heading a person's line sits under in a roster-ordered list (教員, D3 … B3, 学生, その他, 卒業生); null off the roster. */
    fun section(profile: LabProfileOut?): String? {
        if (profile == null) return null
        if (profile.affiliation == "student") return profile.grade ?: L10n.str(R.string.roster_student)
        return AFFILIATIONS.firstOrNull { it.first == profile.affiliation }?.second
    }

    /** A roster-ordered list cut into its runs under one heading, people off the roster (or of an unknown affiliation) last. */
    fun sections(people: List<UserPublic>, roster: Map<String, LabProfileOut>): List<Pair<String, List<UserPublic>>> {
        val runs = ArrayList<Pair<String, MutableList<UserPublic>>>()
        people.forEach { user ->
            val heading = section(roster[user.id]) ?: OFF_ROSTER
            if (runs.lastOrNull()?.first == heading) runs.last().second.add(user) else runs.add(heading to mutableListOf(user))
        }
        return runs
    }

    /** The short label for a line: 教授, M1, 卒業生 … ("" for an affiliation this app does not know). */
    fun label(profile: LabProfileOut): String = when (profile.affiliation) {
        "faculty" -> RANKS.firstOrNull { it.first == profile.rank }?.second ?: L10n.str(R.string.roster_faculty)
        "student" -> profile.grade ?: L10n.str(R.string.roster_student)
        else -> AFFILIATIONS.firstOrNull { it.first == profile.affiliation }?.second ?: ""
    }

    /** 「指導教員: 加納」, or null without one. */
    fun supervisorLabel(profile: LabProfileOut, users: Map<String, UserPublic>): String? =
        profile.supervisorId?.let { users[it]?.displayName }?.let { L10n.str(R.string.roster_supervisor, it) }

    /** How two titles compare: after NFKC, trimming and lower-casing (「ｄ１」 is 「D1」). */
    private fun titleKey(text: String): String = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFKC).trim().lowercase()

    /**
     * The title (肩書) beside the roster label (LAB.md 「肩書と名簿」, cases in apps/shared/title-display.json): the roster's
     * label (教授, M2 …) is shown wherever a title is; the title adds what the roster does not say (研究室長, TA).
     * The second value: the title, unless it is empty or the label again.
     */
    fun titleParts(title: String?, profile: LabProfileOut?): Pair<String?, String?> {
        val label = profile?.let { label(it) }?.takeIf { it.isNotEmpty() }
        val text = title?.trim()?.takeIf { it.isNotEmpty() } ?: return label to null
        return label to (if (label != null && titleKey(label) == titleKey(text)) null else text)
    }

    /** The title as shown: 「M2」, 「研究室長」, 「M2 · 研究室長」, or null for nothing. */
    fun displayTitle(title: String?, profile: LabProfileOut?): String? =
        titleParts(title, profile).toList().filterNotNull().joinToString(" · ").ifEmpty { null }

    /** What a list that shows the roster label as a badge adds after it: the title unless it is empty or the label again. */
    fun titleExtra(title: String?, profile: LabProfileOut?): String? = titleParts(title, profile).second

    /** 「M1 · 指導教員: 加納」: the label and the supervisor, for the profile card (lists show the label as a badge). */
    fun summary(profile: LabProfileOut, users: Map<String, UserPublic>): String =
        listOf(label(profile), supervisorLabel(profile, users)).filter { !it.isNullOrEmpty() }.joinToString(" · ")
}

/** The roster label (教授, M1 …) as a small badge next to a name in member lists (M23). */
@Composable
fun RosterBadge(profile: LabProfileOut, modifier: Modifier = Modifier) {
    val label = Roster.label(profile)
    if (label.isEmpty()) return
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSecondaryContainer,
        maxLines = 1,
        modifier = modifier.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
    )
}
