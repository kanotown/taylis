package jp.chikuwachat.android.api

import jp.chikuwachat.android.L10n

/**
 * The words for server errors in the UI language (docs/I18N.md). The tables are generated from apps/shared/errors.json
 * ([ErrorMessages]); a language without a table, or a code its table lacks, falls back to Japanese.
 */
object ErrorTexts {
    class Table(val byCode: Map<String, String>, val byStatus: Map<String, String>, val network: String, val unknown: String)

    private fun tableFor(lang: String): Table? {
        val byCode = ErrorMessages.byCodeByLocale[lang] ?: return null
        return Table(
            byCode,
            ErrorMessages.byStatusByLocale[lang] ?: emptyMap(),
            ErrorMessages.networkByLocale[lang] ?: ErrorMessages.networkByLocale.getValue("ja"),
            ErrorMessages.unknownByLocale[lang] ?: ErrorMessages.unknownByLocale.getValue("ja"),
        )
    }

    private val japanese = tableFor("ja")!!

    /** Tables by language, generated from errors.json (ja / en / zh-Hans). */
    private val tables: Map<String, Table> = ErrorMessages.byCodeByLocale.keys.associateWith { tableFor(it)!! }

    private fun table(): Table = tables[L10n.language] ?: japanese

    /** The text for an error code, or null when no table knows it. */
    fun code(code: String): String? = table().byCode[code] ?: japanese.byCode[code]

    /** The fallback by HTTP status ("5xx" for any server error). */
    fun status(status: Int): String? {
        val key = if (status >= 500) "5xx" else status.toString()
        return table().byStatus[key] ?: japanese.byStatus[key]
    }

    val network: String get() = table().network
    val unknown: String get() = table().unknown

    /** An API failure in words: its code's text, else its status's, else the generic one. */
    fun describe(e: ApiException.Api): String = code(e.code) ?: status(e.status) ?: unknown
}
